/**
 * Plain text for a push notification from an agent's markdown reply: links become their
 * label, code fences, inline code ticks, emphasis and heading/list markers are dropped, and
 * whitespace collapses, so the notification reads as a sentence instead of raw markdown.
 */
export function notificationTextFromMarkdown(md: string, maxLen = 180): string {
  let s = md;
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/<(https?:\/\/[^>]+)>/g, '$1');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
  s = s.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
  s = s.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}
