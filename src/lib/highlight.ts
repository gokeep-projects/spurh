function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightCode(value: string, language = 'text'): string {
  const escaped = escapeHtml(value);
  if (language !== 'json') return escaped;

  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:)|("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")|\b(true|false)\b|\b(null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
    (token, key: string | undefined, string: string | undefined, boolean: string | undefined, nil: string | undefined) => {
      const className = key ? 'syntax-key' : string ? 'syntax-string' : boolean ? 'syntax-boolean' : nil ? 'syntax-null' : 'syntax-number';
      return `<span class="${className}">${token}</span>`;
    },
  );
}
