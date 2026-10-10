const screen = document.getElementById('screen');
const pane = screen.querySelector('.body');
const toggle = document.getElementById('toggle-grid');
const cellWidth = 10;
const cellHeight = 20;
const probe = document.createElement('span');
probe.className = 'font-probe';
probe.textContent = '00000000000000000000';
screen.append(probe);
let pending = false;
const guides = document.createElement('div');
guides.className = 'grid-guides';
guides.setAttribute('aria-hidden', 'true');
guides.hidden = true;
document.body.append(guides);
let guideCoordinates = '';
let guidePending = false;

function renderGuides() {
  guidePending = false;
  guides.hidden = !screen.classList.contains('grid');
  if (guides.hidden) return;
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  const content = document.getElementById('content');
  const clip = content.getBoundingClientRect();
  const lines = new Set();
  screen.querySelectorAll('button, .button, #ttl, #join-code, #led, #timer').forEach(element => {
    if (!element.getClientRects().length || getComputedStyle(element).visibility !== 'visible') return;
    const rect = element.getBoundingClientRect();
    const left = rect.left + (element.id === 'timer' ? 4 * cellWidth : 0);
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= left
      || rect.right <= 0 || left >= width || rect.bottom <= 0 || rect.top >= height) return;
    if (content.contains(element) && (rect.right <= clip.left || left >= clip.right
      || rect.bottom <= clip.top || rect.top >= clip.bottom)) return;
    for (const coordinate of [left, rect.right]) {
      const position = Math.round(coordinate);
      if (position >= 0 && position < width) lines.add(`v:${position}`);
    }
    for (const coordinate of [rect.top, rect.bottom]) {
      const position = Math.round(coordinate);
      if (position >= 0 && position < height) lines.add(`h:${position}`);
    }
  });
  const coordinates = Array.from(lines).sort();
  const signature = `${width}:${height}:${coordinates.join(',')}`;
  if (signature === guideCoordinates) return;
  guideCoordinates = signature;
  const fragment = document.createDocumentFragment();
  for (const coordinate of coordinates) {
    const [direction, position] = coordinate.split(':');
    const line = document.createElement('div');
    line.className = direction === 'v' ? 'grid-guide-vertical' : 'grid-guide-horizontal';
    line.style[direction === 'v' ? 'left' : 'top'] = `${position}px`;
    fragment.append(line);
  }
  guides.replaceChildren(fragment);
}

function scheduleGuides() {
  if (guidePending) return;
  guidePending = true;
  requestAnimationFrame(renderGuides);
}

// Coordinates are zero-based; CSS grid lines are one-based.
function place(element, column, row, width, height = 1) {
  if (element.matches('button, .button')) width = Array.from(element.textContent).length + Number(element.dataset.extraCells || 0);
  element.style.gridColumn = `${column + 1} / span ${Math.max(1, width)}`;
  element.style.gridRow = `${row + 1} / span ${Math.max(1, height)}`;
  element.dataset.column = column;
  element.dataset.row = row;
}

function layoutContent(columns, rows) {
  const find = selector => screen.querySelector(selector);
  const buttonCells = selector => Array.from(find(selector).textContent).length;
  screen.querySelectorAll('button, .button').forEach(button => {
    const cells = Array.from(button.textContent).length + Number(button.dataset.extraCells || 0);
    button.style.width = `${cells * cellWidth}px`;
  });
  const text = (selector, row, width = columns, column = 0) => {
    const element = find(selector);
    if (element.hidden) return row;
    place(element, column, row, width);
    const height = Math.max(1, Math.ceil(element.getBoundingClientRect().height / cellHeight));
    place(element, column, row, width, height);
    return row + height;
  };
  const contentRows = Math.max(0, rows - 4);
  const centerRow = Math.max(0, Math.floor((contentRows - 5) / 2));
  const content = find('#content');
  place(content, 0, 2, columns, Math.max(1, contentRows));
  content.style.height = `${contentRows * cellHeight}px`;
  const timerCells = Array.from(find('#timer').textContent).length;
  const toggleColumn = Math.max(2, columns - timerCells - 9);
  place(find('#led'), 0, 0, 1);
  place(find('#status'), 2, 0, Math.max(1, toggleColumn - 3));
  place(find('#timer'), toggleColumn + 9, 0, timerCells);
  place(toggle, toggleColumn, 0, 8);
  place(find('#tagline'), Math.max(0, columns - 24), Math.max(0, rows - 1), Math.min(24, columns));
  find('#tagline').style.visibility = rows >= 3 ? '' : 'hidden';
  find('#leave').style.visibility = rows >= 3 ? '' : 'hidden';
  let row = centerRow;

  if (!find('#entry').hidden) {
    const lifetimeColumn = Math.max(0, Math.floor((columns - 20) / 2));
    place(find('.create-row label'), lifetimeColumn, row, Math.min(4, columns));
    if (columns >= 20) {
      place(find('#ttl'), lifetimeColumn + 5, row, 3);
      place(find('#ttl-unit'), lifetimeColumn + 9, row, 2);
      place(find('#create'), lifetimeColumn + 12, row, 8);
      row += 1;
    } else {
      place(find('#ttl'), 0, row + 1, 3);
      place(find('#ttl-unit'), 4, row + 1, 2);
      place(find('#create'), 0, row + 2, Math.min(8, columns));
      row += 3;
    }
  }
  if (!find('#waiting').hidden) {
    const codeColumn = Math.max(0, Math.floor((columns - 20) / 2));
    place(find('#code'), codeColumn, row + 1, 9);
    place(find('#join-code'), codeColumn, row + 3, 9);
    if (columns >= 30) {
      place(find('#copy'), codeColumn + 11, row + 1, 9);
      place(find('#join'), codeColumn + 10, row + 3, 10);
      row += 4;
    } else {
      place(find('#copy'), 0, row + 5, 9);
      place(find('#join'), Math.max(10, columns - 10), row + 5, 10);
      row += 6;
    }
  }
  const folderVisible = !find('#folder').hidden;
  const routeColumn = buttonCells('#leave') + 1;
  const routeWidth = Math.max(0, columns - 14 - routeColumn - 1);
  find('#tagline').style.display = folderVisible ? 'none' : '';
  find('.route').style.display = folderVisible && rows >= 3 && routeWidth > 0 ? '' : 'none';
  find('#hotkeys').style.display = rows >= 3 ? '' : 'none';
  find('.folder-head').style.display = folderVisible && rows >= 3 ? 'contents' : 'none';
  if (folderVisible) {
    place(find('label[for="add-files"]'), Math.max(0, columns - 3), Math.max(0, rows - 1), 3);
    place(find('#add-folder'), Math.max(0, columns - 14), Math.max(0, rows - 1), 10);
    row = 0;
    const files = find('#files');
    files.style.setProperty('--content-columns', columns);
    place(files, 0, row, columns);
    const count = files.querySelectorAll('.file').length;
    const height = count || Math.max(1, Math.ceil(files.querySelector('.empty')?.getBoundingClientRect().height / cellHeight) || 1);
    place(files, 0, row, columns, height);
    files.querySelectorAll('.file').forEach((file, index) => place(file, 0, index, columns));
    row += height;
    if (!find('#transfer').hidden) {
      row = text('#transfer-label', row + 1, columns >= 26 ? columns - 9 : columns);
      place(find('#cancel-transfer'), columns >= 26 ? columns - buttonCells('#cancel-transfer') : 0,
        columns >= 26 ? row - 1 : row, Math.min(10, columns));
      if (columns < 26) row += 1;
      place(find('#progress'), 0, row + 1, columns);
      row = text('#progress-text', row + 2);
    }
    if (routeWidth > 0) place(find('.route'), routeColumn, Math.max(0, rows - 1), routeWidth);
  }
  place(find('#hotkeys'), 0, Math.max(0, rows - 2), columns);
  place(find('#leave'), 0, Math.max(0, rows - 1), 12);

}

function layout() {
  pending = false;
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  const columns = Math.max(0, Math.floor(width / cellWidth) - 2);
  const rows = Math.max(0, Math.floor(height / cellHeight) - 2);
  screen.style.left = `${Math.floor((width - columns * cellWidth) / 2)}px`;
  screen.style.top = `${Math.floor((height - rows * cellHeight) / 2)}px`;
  screen.style.width = `${columns * cellWidth}px`;
  screen.style.height = `${rows * cellHeight}px`;
  screen.style.setProperty('--columns', Math.max(1, columns));
  screen.style.setProperty('--rows', Math.max(1, rows));
  screen.dataset.columns = columns;
  screen.dataset.rows = rows;
  screen.style.setProperty('--tracking', `${cellWidth - probe.getBoundingClientRect().width / 20}px`);
  const notice = document.getElementById('notice');
  const noticeRows = notice.hidden ? 0 : Math.ceil(notice.getBoundingClientRect().height / cellHeight);
  const availableRows = Math.max(1, rows - noticeRows);
  const paneWidth = Math.min(columns, 50);
  const contentWidth = Math.max(1, paneWidth);
  pane.style.setProperty('--content-columns', contentWidth);
  const paneHeight = Math.min(20, availableRows);
  const paneRow = Math.min(Math.max(0, Math.floor((rows - paneHeight) / 2)), availableRows - paneHeight);
  place(pane, Math.floor((columns - paneWidth) / 2), paneRow,
    contentWidth, paneHeight);
  layoutContent(contentWidth, paneHeight);
  renderGuides();
}

function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(layout);
}

toggle.addEventListener('pointerdown', event => event.preventDefault());
toggle.addEventListener('click', () => {
  const visible = screen.classList.toggle('grid');
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.textContent = visible ? 'grid:on' : 'grid:off';
  schedule();
});
new MutationObserver(records => {
  const led = document.getElementById('led');
  if (records.some(record => record.target !== led && !led.contains(record.target))) schedule();
}).observe(screen, {
  subtree: true, childList: true, characterData: true,
  attributes: true, attributeFilter: ['hidden'],
});
window.addEventListener('resize', schedule);
document.getElementById('content').addEventListener('scroll', scheduleGuides, true);
screen.addEventListener('focusin', scheduleGuides);
screen.addEventListener('focusout', scheduleGuides);
let pointerPosition = null;
const focusHoveredButton = event => {
  if (event.pointerType !== 'mouse') return;
  const moved = !pointerPosition || pointerPosition.x !== event.screenX || pointerPosition.y !== event.screenY;
  pointerPosition = { x: event.screenX, y: event.screenY };
  if (!moved || event.buttons) return;
  const file = event.target.closest('.file');
  const button = file ? file.querySelector('.file-name') : event.target.closest('button, .button');
  if (button && button !== toggle && button !== document.activeElement) button.focus({ preventScroll: true });
};
screen.addEventListener('pointermove', focusHoveredButton);
document.addEventListener('keydown', event => {
  if (document.activeElement === toggle && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault(); return;
  }
  if (event.key === 'Enter' && document.activeElement?.matches('label.button')) {
    event.preventDefault();
    document.activeElement.click();
    return;
  }
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
  const step = { h: -1, ArrowLeft: -1, j: 1, ArrowDown: 1,
    k: -1, ArrowUp: -1, l: 1, ArrowRight: 1 }[event.key];
  const tab = event.key === 'Tab';
  if (!tab && !step) return;
  const active = document.activeElement;
  if (step && (event.shiftKey || active?.isContentEditable
    || active?.closest('input, textarea, select'))) return;
  const content = document.getElementById('content');
  const buttons = Array.from(screen.querySelectorAll('button, .button'))
    .filter(button => button !== toggle && !button.matches('.file-action')
      && button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden')
    .map(button => {
      const rect = button.getBoundingClientRect();
      let top = rect.top;
      let left = rect.left;
      // Order by layout position, independent of scrolling inside the content.
      for (let parent = button.parentElement; parent; parent = parent.parentElement) {
        top += parent.scrollTop;
        left += parent.scrollLeft;
      }
      return { button, top, left };
    });
  // Place the fixed footer after all content rows, including off-screen rows.
  const lastContentTop = Math.max(-Infinity, ...buttons.filter(item => content.contains(item.button)).map(item => item.top));
  for (const item of buttons) {
    if (!content.contains(item.button)) item.top = Math.max(item.top, lastContentTop + cellHeight);
  }
  buttons.sort((a, b) => a.top - b.top || a.left - b.left);
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.findIndex(item => item.button === active);
  if (tab) {
    const movement = event.shiftKey ? -1 : 1;
    const next = current < 0 ? (movement < 0 ? buttons.length - 1 : 0)
      : (current + movement + buttons.length) % buttons.length;
    buttons[next].button.focus();
    return;
  }
  if (current < 0) { buttons[0].button.focus(); return; }
  const origin = buttons[current];
  const horizontal = ['h', 'l', 'ArrowLeft', 'ArrowRight'].includes(event.key);
  const candidates = buttons.filter(item => horizontal
    ? Math.abs(item.top - origin.top) < cellHeight / 2 && step * (item.left - origin.left) > 0
    : step * (item.top - origin.top) > cellHeight / 2);
  if (!horizontal && !candidates.length) {
    const wrapTop = step > 0 ? buttons[0].top : buttons[buttons.length - 1].top;
    candidates.push(...buttons.filter(item => Math.abs(item.top - wrapTop) < cellHeight / 2));
  }
  candidates.sort((a, b) => horizontal
    ? Math.abs(a.left - origin.left) - Math.abs(b.left - origin.left)
    : Math.abs(a.top - origin.top) - Math.abs(b.top - origin.top)
      || Math.abs(a.left - origin.left) - Math.abs(b.left - origin.left));
  candidates[0]?.button.focus();
});
document.fonts.ready.then(schedule);
layout();
