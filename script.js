const API_BASE = window.location.origin;
const PRICE_CACHE_MS = 10 * 60 * 1000;
const REQUIRED_MUTATIONS = ["Phantom", "Crystal"];

let brainrots = ["Garama and Madundung", "Dragon Cannelloni", "Hydra Bunny", "Strawberry Elephant"];
let mutations = ["None", "Gold", "Diamond", "Bloodrot", "Candy", "Lava", "Galaxy", "Yin-Yang", "Radioactive", "Rainbow", "Phantom", "Crystal"];
let nextId = 1;

const state = {
  your: [],
  their: [],
  cache: new Map(),
};

const els = {
  yourItems: document.querySelector("#yourItems"),
  theirItems: document.querySelector("#theirItems"),
  yourTotal: document.querySelector("#yourTotal"),
  theirTotal: document.querySelector("#theirTotal"),
  tradeResult: document.querySelector("#tradeResult"),
  tradeDiff: document.querySelector("#tradeDiff"),
  resultCard: document.querySelector(".result-card"),
  priceRows: document.querySelector("#priceRows"),
  findPrices: document.querySelector("#findPrices"),
  minReviews: document.querySelector("#minReviews"),
  template: document.querySelector("#itemTemplate"),
};

function newItem(side, name = "", mutation = "None", income = "", qty = 1) {
  return {
    id: nextId++,
    side,
    name,
    searchQuery: name,
    custom: false,
    mutation,
    income,
    qty,
    status: "idle",
    result: null,
    error: "",
    fromCache: false,
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function sameText(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function ensureRequiredMutations() {
  for (const mutation of REQUIRED_MUTATIONS) {
    if (!mutations.some((item) => sameText(item, mutation))) mutations.push(mutation);
  }
}

function findExactBrainrot(query) {
  return brainrots.find((name) => sameText(name, query)) || "";
}

function itemName(item) {
  return (item.name || item.searchQuery || "").trim();
}

function brainrotOptionsHtml(query) {
  const typed = String(query || "").trim();
  const normalized = typed.toLowerCase();
  const options = normalized ? brainrots.filter((name) => name.toLowerCase().startsWith(normalized)).slice(0, 80) : brainrots.slice(0, 80);
  return `
    ${options.map((name) => `<button type="button" class="brainrot-option" data-brainrot="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("")}
    ${typed ? `<button type="button" class="brainrot-option custom-option" data-custom-brainrot="${escapeHtml(typed)}">Custom brainrot: ${escapeHtml(typed)}</button>` : ""}
    ${options.length || typed ? "" : `<span class="brainrot-empty">No matches</span>`}
  `;
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatIncome(value) {
  if (!value) return "unknown";
  if (value >= 1e12) return `${Number((value / 1e12).toFixed(2))}T`;
  if (value >= 1e9) return `${Number((value / 1e9).toFixed(2))}B`;
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(2))}M`;
  if (value >= 1e3) return `${Number((value / 1e3).toFixed(2))}K`;
  return String(value);
}

function allItems() {
  return [...state.your, ...state.their];
}

function sideTotal(side) {
  return state[side].reduce((sum, item) => sum + Number(item.result?.best?.price || 0) * Math.max(1, Number(item.qty || 1)), 0);
}

function updateScoreboard() {
  const your = sideTotal("your");
  const their = sideTotal("their");
  els.yourTotal.textContent = formatMoney(your);
  els.theirTotal.textContent = formatMoney(their);
  els.resultCard.classList.remove("is-loss", "is-fair");

  if (allItems().some((item) => item.status === "loading")) {
    els.tradeResult.textContent = "Searching...";
    els.tradeDiff.textContent = "Checking prices.";
    return;
  }

  if (!your && !their) {
    els.tradeResult.textContent = "Find prices";
    els.tradeDiff.textContent = "Add both offers, then check prices.";
    return;
  }

  const diff = their - your;
  if (Math.abs(diff) < 0.5) {
    els.tradeResult.textContent = "FAIR";
    els.tradeDiff.textContent = `Difference ${formatMoney(diff)}.`;
    els.resultCard.classList.add("is-fair");
  } else if (diff > 0) {
    els.tradeResult.textContent = `W +${formatMoney(diff)}`;
    els.tradeDiff.textContent = "Their offer is worth more.";
  } else {
    els.tradeResult.textContent = `L -${formatMoney(Math.abs(diff))}`;
    els.tradeDiff.textContent = "Your offer is worth more.";
    els.resultCard.classList.add("is-loss");
  }
}

function renderItem(item) {
  const node = els.template.content.firstElementChild.cloneNode(true);
  node.dataset.id = item.id;
  const search = node.querySelector('[name="searchQuery"]');
  const menu = node.querySelector(".brainrot-menu");
  const mutation = node.querySelector('[name="mutation"]');
  const income = node.querySelector('[name="income"]');
  const qty = node.querySelector('[name="qty"]');

  search.value = item.searchQuery;
  menu.innerHTML = brainrotOptionsHtml(item.searchQuery);
  mutation.innerHTML = mutations.map((value) => `<option value="${escapeHtml(value)}" ${sameText(item.mutation, value) ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
  income.value = item.income;
  qty.value = item.qty;
  return node;
}

function renderItems() {
  els.yourItems.replaceChildren(...state.your.map(renderItem));
  els.theirItems.replaceChildren(...state.their.map(renderItem));
  renderPriceRows();
  updateScoreboard();
}

function renderPriceRows() {
  els.priceRows.innerHTML = "";
  for (const item of allItems()) {
    const best = item.result?.best;
    const row = document.createElement("article");
    row.className = "price-row";
    const label = item.side === "your" ? "Your offer" : "Their offer";
    const qtyText = `qty ${Math.max(1, Number(item.qty || 1))}`;

    if (item.status === "loading") {
      row.innerHTML = `<div><strong>${escapeHtml(itemName(item) || "Empty item")}</strong><span>${label} - ${qtyText}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income)}</span><strong>Searching...</strong><div><span>Checking current estimates.</span></div>`;
    } else if (best) {
      row.innerHTML = `
        <div><strong>${escapeHtml(itemName(item))}</strong><span>${label} - ${qtyText}</span></div>
        <span class="pill">${escapeHtml(item.mutation)}</span>
        <span>${escapeHtml(best.incomeRange || item.result.incomeRange)} - ${formatIncome(best.incomeNumber)}/s</span>
        <strong>${formatMoney(best.price * Math.max(1, Number(item.qty || 1)))}</strong>
        <div><strong>Estimated value</strong><span>Matched by item, mutation, and income.</span></div>
      `;
    } else if (item.error) {
      row.innerHTML = `<div><strong>${escapeHtml(itemName(item) || "Empty item")}</strong><span>${label} - ${qtyText}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income)}</span><strong>No price</strong><div><span>${escapeHtml(item.error)}</span></div>`;
    } else {
      row.innerHTML = `<div><strong>${escapeHtml(itemName(item) || "Empty item")}</strong><span>${label} - ${qtyText}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income || "income needed")}</span><strong>Not searched</strong><div><span>Press Find prices.</span></div>`;
    }
    els.priceRows.append(row);
  }
}

function findItemByElement(element) {
  const id = Number(element.closest(".item-row")?.dataset.id || 0);
  return allItems().find((item) => item.id === id);
}

function resetItem(item) {
  item.status = "idle";
  item.result = null;
  item.error = "";
  item.fromCache = false;
}

function priceCacheKey(item) {
  const minReviews = Math.max(0, Number(els.minReviews.value || 0));
  const custom = item.custom || !findExactBrainrot(itemName(item)) ? "1" : "0";
  return `${itemName(item)}|${item.mutation}|${item.income}|reviews:${minReviews}|custom:${custom}`;
}

function getCachedPrice(key) {
  const cached = state.cache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.time > PRICE_CACHE_MS) {
    state.cache.delete(key);
    return null;
  }
  return cached;
}

async function lookupItem(item) {
  const name = itemName(item);
  if (!name || !item.income) {
    item.status = "error";
    item.error = "Choose brainrot and income first.";
    return;
  }

  const key = priceCacheKey(item);
  const cached = getCachedPrice(key);
  if (cached) {
    item.result = cached.result;
    item.status = item.result.best ? "done" : "error";
    item.error = item.result.best ? "" : "No matching price estimate found.";
    item.fromCache = true;
    return;
  }

  const minReviews = Math.max(0, Number(els.minReviews.value || 0));
  const custom = item.custom || !findExactBrainrot(name) ? "1" : "0";
  const params = new URLSearchParams({ name, mutation: item.mutation, income: item.income, minReviews, custom });
  const response = await fetch(`${API_BASE}/api/search?${params.toString()}`);
  const result = await response.json();
  state.cache.set(key, { result, time: Date.now() });
  item.result = result;
  item.status = result.best ? "done" : "error";
  item.error = result.best ? "" : result.error || "No matching price estimate found.";
}

async function lookupAll() {
  const queue = allItems();
  els.findPrices.disabled = true;
  for (const item of queue) {
    item.status = "loading";
    item.error = "";
  }
  renderPriceRows();
  updateScoreboard();

  let done = 0;
  for (const item of queue) {
    els.findPrices.textContent = `Searching ${done + 1}/${queue.length}...`;
    try {
      await lookupItem(item);
    } catch {
      item.status = "error";
      item.error = "Price check failed. Try again.";
    }
    done += 1;
    renderPriceRows();
    updateScoreboard();
  }

  els.findPrices.disabled = false;
  els.findPrices.textContent = "Find prices";
}

async function loadOptions() {
  try {
    const response = await fetch(`${API_BASE}/api/options`);
    const options = await response.json();
    if (Array.isArray(options.brainrots) && options.brainrots.length) brainrots = options.brainrots;
    if (Array.isArray(options.mutations) && options.mutations.length) mutations = options.mutations;
  } catch {
    try {
      const response = await fetch("brainrot-library.json");
      const options = await response.json();
      if (Array.isArray(options.brainrots) && options.brainrots.length) brainrots = options.brainrots;
      if (Array.isArray(options.mutations) && options.mutations.length) mutations = options.mutations;
    } catch {
      // Keep inline fallback.
    }
  }
  ensureRequiredMutations();
}

document.addEventListener("input", (event) => {
  const item = findItemByElement(event.target);
  if (!item || !event.target.name) return;
  if (event.target.name === "searchQuery") {
    item.searchQuery = event.target.value;
    item.name = item.custom ? "" : findExactBrainrot(event.target.value);
    const menu = event.target.closest(".brainrot-picker")?.querySelector(".brainrot-menu");
    if (menu) menu.innerHTML = brainrotOptionsHtml(event.target.value);
  } else if (event.target.name === "qty") {
    item.qty = Math.max(1, Number(event.target.value || 1));
  } else {
    item[event.target.name] = event.target.value;
  }
  resetItem(item);
  renderPriceRows();
  updateScoreboard();
});

document.addEventListener("change", (event) => {
  const item = findItemByElement(event.target);
  if (!item || !event.target.name || event.target.name === "searchQuery") return;
  item[event.target.name] = event.target.name === "qty" ? Math.max(1, Number(event.target.value || 1)) : event.target.value;
  resetItem(item);
  renderPriceRows();
  updateScoreboard();
});

document.addEventListener("pointerdown", (event) => {
  const option = event.target.closest(".brainrot-option");
  if (!option) return;
  event.preventDefault();
  const item = findItemByElement(option);
  if (!item) return;
  if (option.dataset.customBrainrot) {
    item.name = "";
    item.searchQuery = option.dataset.customBrainrot;
    item.custom = true;
  } else {
    item.name = option.dataset.brainrot;
    item.searchQuery = option.dataset.brainrot;
    item.custom = false;
  }
  resetItem(item);
  renderItems();
});

document.addEventListener("click", (event) => {
  const addSide = event.target.closest("[data-add]")?.dataset.add;
  if (addSide) {
    state[addSide].push(newItem(addSide));
    renderItems();
    return;
  }

  const remove = event.target.closest(".remove-item");
  if (remove) {
    const item = findItemByElement(remove);
    if (!item) return;
    state[item.side] = state[item.side].filter((row) => row.id !== item.id);
    renderItems();
  }
});

els.findPrices.addEventListener("click", lookupAll);

state.your.push(newItem("your", "Garama and Madundung", "None", "1.8B", 1));
state.their.push(newItem("their", "Dragon Cannelloni", "None", "250M", 1));

loadOptions().finally(renderItems);
