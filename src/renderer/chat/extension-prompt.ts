/** Ask's custom-answer editor includes its terminal choice list in the title. */
export function extensionPromptHeading(title: string, method: string) {
  if ((method !== 'input' && method !== 'editor') || !/Enter your response:\s*$/.test(title) || !/[○◉]\s/.test(title)) return { title, custom: false };
  const question = title.slice(0, title.search(/[○◉]\s/)).trim();
  return { title: question || title, custom: !!question };
}
