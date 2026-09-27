import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Module-level cache so revisiting the same message does not re-read the
 * file. The key includes workspace and MIME context so a reference cannot
 * show stale bytes after a project or selected image changes.
 */
const dataUrlCache = new Map<string, string>();
const DATA_URL_CACHE_ENTRIES = 50;
const DATA_URL_CACHE_MAX_BYTES = 40 * 1024 * 1024;
let dataUrlCacheBytes = 0;

function cacheKey(workspaceRoot: string | null, ref: string, mimeType?: string): string {
  return `${workspaceRoot ?? ""}\u0000${ref}\u0000${mimeType ?? ""}`;
}

function rememberDataUrl(key: string, dataUrl: string) {
  const existing = dataUrlCache.get(key);
  if (existing !== undefined) {
    dataUrlCacheBytes -= existing.length;
    dataUrlCache.delete(key);
  }
  dataUrlCacheBytes += dataUrl.length;
  dataUrlCache.set(key, dataUrl);
  while (
    dataUrlCache.size > DATA_URL_CACHE_ENTRIES ||
    dataUrlCacheBytes > DATA_URL_CACHE_MAX_BYTES
  ) {
    const oldest = dataUrlCache.keys().next().value;
    if (oldest === undefined) break;
    const value = dataUrlCache.get(oldest);
    if (value !== undefined) dataUrlCacheBytes -= value.length;
    dataUrlCache.delete(oldest);
  }
}

/**
 * Load a contained image ref into a bounded data URL. Host containment
 * (workspace, scratch, attachments) is the gate; failures resolve to null.
 */
export function useReferencedImageDataUrl(
  ref: string | null | undefined,
  workspaceRoot: string,
): { dataUrl: string | null; error?: string } {
  const { t } = useTranslation();
  const normalizedRef = typeof ref === "string" ? ref.trim() : "";
  const requestedKey = workspaceRoot && normalizedRef && !/^(?:https?|data|blob):/i.test(normalizedRef)
    ? cacheKey(workspaceRoot, normalizedRef)
    : null;
  const [resolved, setResolved] = useState<{ key: string; dataUrl: string | null; error?: string }>({
    key: "", dataUrl: null,
  });
  useEffect(() => {
    if (!requestedKey) {
      setResolved({ key: "", dataUrl: null });
      return;
    }
    const cached = dataUrlCache.get(requestedKey);
    if (cached !== undefined) {
      setResolved({ key: requestedKey, dataUrl: cached });
      return;
    }
    let current = true;
    setResolved({ key: requestedKey, dataUrl: null });
    void window.ompDesktop
      .readFile(workspaceRoot, normalizedRef)
      .then((result) => {
        const next = result.kind === "image" && result.dataUrl ? result.dataUrl : null;
        if (next) rememberDataUrl(requestedKey, next);
        if (current) setResolved({ key: requestedKey, dataUrl: next, error: next ? undefined : t("ompVisual.imagePreviewFailed", { kind: result.kind }) });
      })
      .catch((error: unknown) => {
        if (current) setResolved({ key: requestedKey, dataUrl: null, error: String(error) });
      });
    return () => {
      current = false;
    };
  }, [requestedKey, normalizedRef, workspaceRoot, t]);
  if (!requestedKey) return { dataUrl: null };
  const cached = dataUrlCache.get(requestedKey);
  return cached !== undefined ? { dataUrl: cached } : resolved.key === requestedKey ? resolved : { dataUrl: null };
}
