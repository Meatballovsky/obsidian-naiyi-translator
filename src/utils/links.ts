/** Inline links, including angle destinations and balanced URL parentheses. */
export function markdownLinkPattern(): RegExp {
  return /\[([^\]\n]*)\]\((<[^<>\n]*>|(?:[^\s()\n]|\([^()\n]*\))*)(?:\s+"[^"\n]*")?\)/g;
}

export function linkTarget(destination: string): string {
  return destination.startsWith("<") ? destination.slice(1, -1) : destination;
}
