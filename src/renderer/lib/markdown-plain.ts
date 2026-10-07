/**
 * One-line plain-text preview of Markdown: drops heading/list/quote markers,
 * link syntax, code ticks and PAIRED emphasis only. Intra-word underscores and
 * lone asterisks stay literal (`FIXTURE_CHILD`, `a*b`, `__init__.py`).
 */
export function plainMarkdownLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+] |\d+[.)] |> ?)+/, '')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])(__?)(?=\S)(.+?)(?<=\S)\2(?!\w)/g, '$1$3')
    .trim();
}
