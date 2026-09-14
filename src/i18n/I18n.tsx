import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { translate, type I18nKey, type Lang, type Vars } from './dict';

export const LANG_STORAGE_KEY = 'lumen.lang';

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: I18nKey, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue>({
  lang: 'zh',
  setLang: () => undefined,
  t: (k) => translate('zh', k)
});

function readInitialLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    return v === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitialLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch {
      // ignore storage errors
    }
  }, []);
  const t = useCallback((key: I18nKey, vars?: Vars) => translate(lang, key, vars), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}