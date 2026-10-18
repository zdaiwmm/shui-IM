/** Assert the visible product contract independently of the app's scroll target. */
export function verifyTimelinePlacement({ visibleTop, composerTop, gap, label }) {
  const list = document.querySelector('#message-list');
  const first = list.firstElementChild, last = list.lastElementChild;
  const topMargin = parseFloat(getComputedStyle(first).marginTop) || 0;
  const bottomMargin = parseFloat(getComputedStyle(last).marginBottom) || 0;
  const firstTop = first.getBoundingClientRect().top - topMargin;
  const lastBottom = last.getBoundingClientRect().bottom + bottomMargin;
  const expectedTop = visibleTop + parseFloat(getComputedStyle(list).paddingTop);
  const short = lastBottom - firstTop <= composerTop - expectedTop - 12 + 1;
  if (short ? Math.abs(firstTop - expectedTop) > 2 || gap < 10 : Math.abs(gap - 12) > 2) {
    throw Error(`${label}: ${JSON.stringify({short,firstTop,expectedTop,gap})}`);
  }
  return {short,firstTop,expectedTop,gap};
}
