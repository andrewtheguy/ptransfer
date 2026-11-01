import { useEffect } from 'react';
import { headFor } from '@/i18n/pages';
import type { Locale } from '@/lib/i18n';

function setMeta(name: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(
    `meta[name="${name}"]`,
  );
  if (!element) {
    element = document.createElement('meta');
    element.name = name;
    document.head.append(element);
  }
  element.content = content;
}

/**
 * Keep the document's language, title, description, canonical and alternate
 * links those of the page being shown. A page loaded by URL already has them
 * from the HTML the build wrote for it; this covers a page reached by
 * navigating, and a path served the fallback `index.html`.
 */
export function useDocumentHead(path: string, locale: Locale): void {
  useEffect(() => {
    const head = headFor(path, locale);
    document.documentElement.lang = head.lang;
    document.title = head.title;
    setMeta('description', head.description);

    for (const link of document.head.querySelectorAll(
      'link[rel="canonical"], link[rel="alternate"][hreflang]',
    )) {
      link.remove();
    }
    if (head.canonical) {
      const canonical = document.createElement('link');
      canonical.rel = 'canonical';
      canonical.href = head.canonical;
      document.head.append(canonical);
    }
    for (const { hreflang, href } of head.alternates) {
      const alternate = document.createElement('link');
      alternate.rel = 'alternate';
      alternate.hreflang = hreflang;
      alternate.href = href;
      document.head.append(alternate);
    }
  }, [path, locale]);
}
