//! Signing in and out, the session cookie, the login throttle and the cross-site protection.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{PASSWORD, START_SECONDS, TestApp, TestAppOptions};

#[tokio::test]
async fn signs_in_with_the_right_password_and_sets_a_session_cookie() {
    let app = TestApp::new().await;

    let response = app.login(PASSWORD).await;

    assert_eq!(response.status, StatusCode::OK);
    let cookie = response.header("set-cookie").unwrap();
    assert!(cookie.starts_with("binsight_session="), "{cookie}");
    for attribute in ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000"] {
        assert!(
            cookie.contains(attribute),
            "{attribute} missing from {cookie}"
        );
    }
    assert!(!cookie.contains("Secure"), "{cookie}");
    assert_eq!(
        response.json(),
        serde_json::json!({ "authenticated": true, "expires_at": "2026-10-21T14:13:20Z" })
    );
    assert_eq!(START_SECONDS + 30 * 86_400, 1_792_592_000);
}

#[tokio::test]
async fn marks_the_cookie_secure_behind_an_https_public_url() {
    let app = TestApp::with(TestAppOptions {
        public_url: Some("https://binsight.example.com"),
        ..TestAppOptions::default()
    })
    .await;

    let response = app.login(PASSWORD).await;

    assert!(response.header("set-cookie").unwrap().contains("Secure"));
}

#[tokio::test]
async fn rejects_login_when_password_is_wrong() {
    let app = TestApp::new().await;

    let response = app.login("not the password at all").await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.header("set-cookie"), None);
    insta::assert_json_snapshot!(response.json(), { ".error.request_id" => "[request_id]" }, @r#"
    {
      "error": {
        "code": "invalid_credentials",
        "message": "the password is incorrect",
        "request_id": "[request_id]"
      }
    }
    "#);
}

#[tokio::test]
async fn reads_the_session_with_the_cookie_it_issued() {
    let app = TestApp::new().await;
    let cookie = app.session_cookie().await;

    let response = app.get_with_cookie("/api/v1/auth/session", &cookie).await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json()["authenticated"], true);
}

#[tokio::test]
async fn answers_401_without_a_session() {
    let app = TestApp::new().await;

    let response = app.get("/api/v1/auth/session").await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.json()["error"]["code"], "unauthenticated");
}

#[tokio::test]
async fn refuses_a_tampered_cookie() {
    let app = TestApp::new().await;
    let cookie = app.session_cookie().await;
    let tampered = cookie.replace("v1.", "v1.9");

    let response = app.get_with_cookie("/api/v1/auth/session", &tampered).await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn refuses_a_cookie_issued_before_the_password_changed() {
    let before = TestApp::new().await;
    let cookie = before.session_cookie().await;
    let after = TestApp::with(TestAppOptions {
        password: "a brand new long password",
        ..TestAppOptions::default()
    })
    .await;

    let response = after.get_with_cookie("/api/v1/auth/session", &cookie).await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn keeps_a_session_across_restarts_with_the_same_secret() {
    let first = TestApp::new().await;
    let cookie = first.session_cookie().await;
    let restarted = TestApp::new().await;

    let response = restarted
        .get_with_cookie("/api/v1/auth/session", &cookie)
        .await;

    assert_eq!(response.status, StatusCode::OK);
}

#[tokio::test]
async fn ends_the_session_after_thirty_days() {
    let app = TestApp::new().await;
    let cookie = app.session_cookie().await;

    app.advance_clock(30 * 86_400 - 1);
    let last_second = app.get_with_cookie("/api/v1/auth/session", &cookie).await;
    app.advance_clock(1);
    let expired = app.get_with_cookie("/api/v1/auth/session", &cookie).await;

    assert_eq!(last_second.status, StatusCode::OK);
    assert_eq!(expired.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn slows_down_after_three_failed_logins() {
    let app = TestApp::new().await;
    for _ in 0..3 {
        assert_eq!(
            app.login("wrong password!").await.status,
            StatusCode::UNAUTHORIZED
        );
    }

    let fourth = app.login(PASSWORD).await;
    app.advance_clock(1);
    let after_waiting = app.login(PASSWORD).await;

    assert_eq!(fourth.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(fourth.header("retry-after"), Some("1"));
    assert_eq!(fourth.json()["error"]["code"], "too_many_attempts");
    assert_eq!(after_waiting.status, StatusCode::OK);
}

#[tokio::test]
async fn never_slows_down_the_owner_for_the_failures_of_another_address() {
    let app = TestApp::new().await;
    for _ in 0..4 {
        app.login_from("wrong password!", "198.51.100.7:50000", &[])
            .await;
    }

    let guesser = app.login_from(PASSWORD, "198.51.100.7:50001", &[]).await;
    let owner = app.login_from(PASSWORD, "192.0.2.1:40000", &[]).await;

    assert_eq!(guesser.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(owner.status, StatusCode::OK);
}

#[tokio::test]
async fn reads_the_client_address_from_the_configured_proxy_header() {
    let app = TestApp::with(TestAppOptions {
        client_ip_header: Some("X-Forwarded-For"),
        ..TestAppOptions::default()
    })
    .await;
    let proxy = "10.0.0.2:60000";
    let guesser = [("x-forwarded-for", "198.51.100.7")];
    for _ in 0..3 {
        app.login_from("wrong password!", proxy, &guesser).await;
    }

    let blocked = app.login_from(PASSWORD, proxy, &guesser).await;
    let owner = app
        .login_from(PASSWORD, proxy, &[("x-forwarded-for", "192.0.2.1")])
        .await;

    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(owner.status, StatusCode::OK);
}

#[tokio::test]
async fn ignores_the_proxy_header_unless_it_is_configured() {
    let app = TestApp::new().await;
    let peer = "198.51.100.7:50000";
    for spoofed in ["192.0.2.1", "192.0.2.2", "192.0.2.3"] {
        app.login_from("wrong password!", peer, &[("x-forwarded-for", spoofed)])
            .await;
    }

    let response = app
        .login_from(PASSWORD, peer, &[("x-forwarded-for", "192.0.2.4")])
        .await;

    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lets_only_three_of_many_simultaneous_wrong_logins_through() {
    let app = std::sync::Arc::new(TestApp::new().await);
    let logins: Vec<_> = (0..24)
        .map(|_| {
            let app = std::sync::Arc::clone(&app);
            tokio::spawn(async move { app.login("wrong password!").await.status })
        })
        .collect();

    let mut statuses = Vec::new();
    for login in logins {
        statuses.push(login.await.unwrap());
    }

    let refused = statuses
        .iter()
        .filter(|status| **status == StatusCode::UNAUTHORIZED)
        .count();
    let throttled = statuses
        .iter()
        .filter(|status| **status == StatusCode::TOO_MANY_REQUESTS)
        .count();
    assert_eq!((refused, throttled), (3, 21));
}

#[tokio::test]
async fn signs_out_by_deleting_the_cookie() {
    let app = TestApp::new().await;
    let cookie = app.session_cookie().await;
    let request = Request::post("/api/v1/auth/logout")
        .header("sec-fetch-site", "same-origin")
        .header("cookie", &cookie)
        .body(Body::empty())
        .unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::NO_CONTENT);
    let removal = response.header("set-cookie").unwrap();
    assert!(removal.starts_with("binsight_session="), "{removal}");
    assert!(removal.contains("Max-Age=0"), "{removal}");
}

#[tokio::test]
async fn signs_out_even_without_a_session() {
    let app = TestApp::new().await;
    let request = Request::post("/api/v1/auth/logout")
        .body(Body::empty())
        .unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn refuses_a_login_posted_from_another_site() {
    let app = TestApp::new().await;
    let request = Request::post("/api/v1/auth/login")
        .header("content-type", "application/json")
        .header("sec-fetch-site", "cross-site")
        .header("origin", "https://evil.example")
        .body(Body::from(format!(r#"{{"password":"{PASSWORD}"}}"#)))
        .unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(response.json()["error"]["code"], "forbidden_cross_origin");
    assert_eq!(response.header("set-cookie"), None);
}

#[tokio::test]
async fn trusts_the_configured_public_url_as_an_origin() {
    let app = TestApp::with(TestAppOptions {
        public_url: Some("https://binsight.example.com"),
        ..TestAppOptions::default()
    })
    .await;
    let request = Request::post("/api/v1/auth/login")
        .header("content-type", "application/json")
        .header("sec-fetch-site", "cross-site")
        .header("origin", "https://binsight.example.com")
        .body(Body::from(format!(r#"{{"password":"{PASSWORD}"}}"#)))
        .unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::OK);
}

#[tokio::test]
async fn lets_clients_without_browser_headers_sign_in() {
    let app = TestApp::new().await;
    let request = Request::post("/api/v1/auth/login")
        .header("content-type", "application/json")
        .body(Body::from(format!(r#"{{"password":"{PASSWORD}"}}"#)))
        .unwrap();

    let response = app.send(request).await;

    assert_eq!(response.status, StatusCode::OK);
}
