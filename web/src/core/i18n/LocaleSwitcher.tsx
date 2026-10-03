import { changeLocale } from '@app/core/i18n/localeActivation';
import {
  isSupportedLocale,
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
  toLanguageTag,
} from '@app/core/i18n/locales';
import { Label, ListBox, Select } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';

export const LocaleSwitcher = () => {
  const { i18n, t } = useLingui();

  return (
    <Select
      className="w-48"
      value={i18n.locale}
      onChange={(locale) => {
        if (isSupportedLocale(locale)) {
          void changeLocale(locale);
        }
      }}
    >
      <Label className="sr-only">{t`Language`}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {SUPPORTED_LOCALES.map((locale) => (
            <ListBox.Item key={locale} id={locale} textValue={LOCALE_NAMES[locale]}>
              <span lang={toLanguageTag(locale)}>{LOCALE_NAMES[locale]}</span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
};
