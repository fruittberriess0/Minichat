export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  })[char]);
}

export function initials(name) {
  const parts = String(name || "M").trim().split(/\s+/);
  return parts.slice(0, 2).map(s => s[0] || "").join("").toUpperCase() || "M";
}

export function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}

export function appendFormattedText(container, value) {
  // Safe Markdown subset: normal text, links, bold, italic and inline code.
  const source = String(value ?? "");
  const tokenPattern = /(https?:\/\/[^\s<]+|\*\*[^*]+\*\*|\*[^*\n]+\*|\x60[^\x60\n]+\x60)/g;
  let last = 0, match;
  while ((match = tokenPattern.exec(source))) {
    if (match.index > last) container.appendChild(document.createTextNode(source.slice(last, match.index)));
    const token = match[0];
    if (/^https?:\/\//i.test(token)) {
      const link = document.createElement("a");
      link.href = token;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = token;
      link.className = "message-link";
      container.appendChild(link);
    } else {
      const element = token.startsWith("**") ? document.createElement("strong")
        : token.startsWith("*") ? document.createElement("em")
        : document.createElement("code");
      element.textContent = token.startsWith("**") ? token.slice(2,-2) : token.slice(1,-1);
      container.appendChild(element);
    }
    last = tokenPattern.lastIndex;
  }
  if (last < source.length) container.appendChild(document.createTextNode(source.slice(last)));
}
