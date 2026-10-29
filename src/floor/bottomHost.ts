/** 底部卡片是正文的兄弟节点，不经过正文美化、HTML 替换或 iframe。 */
export function bottomAnchors(mesText: HTMLElement, count: number): HTMLElement[] {
  const parent = mesText.parentElement;
  if (!parent) return [];
  let host = [...parent.children].find(el => el.hasAttribute('data-bbi-bottom')) as HTMLElement | undefined;
  if (!count) {
    host?.remove();
    return [];
  }
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('data-bbi-bottom', '');
    host.style.cssText = 'display:block;clear:both;min-width:0;width:100%;';
    mesText.after(host);
  }
  while (host.children.length > count) host.lastElementChild?.remove();
  while (host.children.length < count) {
    const anchor = document.createElement('div');
    anchor.setAttribute('data-bbi-bottom-slot', '');
    host.appendChild(anchor);
  }
  return [...host.children] as HTMLElement[];
}
