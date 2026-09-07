'use client';

import { COPIED_RESET_MS } from '@app/applications/Shared/Domain/timings';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { Button, Modal, Spinner } from '@heroui/react';
import { Check, Copy, Download, Share2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; blob: Blob }
  | { status: 'error' };

interface ImageShareDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** Download filename (also the Web-Share file name). */
  filename: string;
  /** Produces the PNG once per open — a server fetch or a client-side render. */
  getImage: (signal?: AbortSignal) => Promise<Blob>;
  /** Optional content above the preview (e.g. a position summary). */
  summary?: ReactNode;
  /** Preview box aspect ratio (CSS `aspect-ratio`), matched to the image — default 3 / 2. */
  aspect?: string;
  /** Title for the native share sheet (falls back to `title`). */
  shareTitle?: string;
}

/**
 * A reusable share dialog for a generated image: an optional summary, the image preview, and
 * share / copy / download actions. The PNG is produced once per open and kept as a blob so it can be
 * shared (Web Share), copied (Clipboard) or downloaded. Source-agnostic — used by the position PnL
 * card (server-rendered) and the PnL chart (client-rendered).
 */
export const ImageShareDialog = ({
  isOpen,
  onClose,
  title,
  filename,
  getImage,
  summary,
  aspect = '3 / 2',
  shareTitle,
}: ImageShareDialogProps) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [copied, setCopied] = useState(false);
  const urlRef = useRef<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState({ status: 'loading' });
      try {
        const blob = await getImage(signal);
        if (signal?.aborted) return;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setState({ status: 'ready', url, blob });
      } catch {
        if (!signal?.aborted) setState({ status: 'error' });
      }
    },
    [getImage],
  );

  // (Re)generate whenever the dialog opens; revoke the object URL on close.
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    void load(controller.signal);
    setCopied(false);
    return () => {
      controller.abort();
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [isOpen, load]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const blob = state.status === 'ready' ? state.blob : null;
  const url = state.status === 'ready' ? state.url : null;

  const shareFile = blob ? new File([blob], filename, { type: 'image/png' }) : null;
  const canShare =
    shareFile != null &&
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [shareFile] });

  const onShare = async () => {
    if (!shareFile) return;
    try {
      await navigator.share({ files: [shareFile], title: shareTitle ?? title });
    } catch {
      /* user cancelled or share failed — no-op */
    }
  };

  const onCopy = async () => {
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      /* clipboard unavailable / denied */
    }
  };

  const onDownload = () => {
    if (!url) return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  return (
    <Modal.Root isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Modal.Backdrop variant="opaque">
        <Modal.Container size="md" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              {summary}
              <div
                className="grid place-items-center overflow-hidden rounded-xl border border-border bg-background"
                style={{ aspectRatio: aspect }}
              >
                {state.status === 'loading' && <Spinner size="md" color="current" />}
                {state.status === 'error' && (
                  <StateMessage
                    variant="error"
                    title="Couldn't generate the image"
                    hint="The card is rendered on the server — retry in a moment."
                    onRetry={() => void load()}
                  />
                )}
                {state.status === 'ready' && url && (
                  // biome-ignore lint/performance/noImgElement: a generated blob URL, not a static asset — next/image can't optimise it.
                  <img src={url} alt={title} className="block h-full w-full object-contain" />
                )}
              </div>
            </Modal.Body>
            <Modal.Footer className="justify-end gap-2">
              {canShare && (
                <Button variant="secondary" size="sm" onPress={() => void onShare()}>
                  <Share2 size={16} /> Share
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                isDisabled={blob == null}
                onPress={() => void onCopy()}
              >
                {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button variant="primary" size="sm" isDisabled={url == null} onPress={onDownload}>
                <Download size={16} /> Download
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
};
