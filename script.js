const API_BASE = window.location.origin;
const PRICE_CACHE_MS = 10 * 60 * 1000;
const PRICE_CACHE_STORAGE_KEY = "brainrot-ratio-price-cache-v2";
const REQUIRED_MUTATIONS = ["Phantom", "Crystal"];

let brainrots = ["Garama and Madundung", "Dragon Cannelloni", "Signore Carapace", "Headless Horseman"];
let mutations = ["None", "Gold", "Diamond", "Bloodrot", "Candy", "Lava", "Galaxy", "Yin-Yang", "Radioactive", "Rainbow", "Phantom", "Crystal"];

const state = {
  source: newItem("Garama and Madundung", "None", "1.8B"),
  target: newItem("Dragon Cannelloni", "None", "250M"),
  cache: new Map(),
};

const els = {
  sourceRow: document.querySelector("#sourceRow"),
  targetRow: document.querySelector("#targetRow"),
  ratioValue: document.querySelector("#ratioValue"),
  ratioText: document.querySelector("#ratioText"),
  priceRows: document.querySelector("#priceRows"),
  findRatio: document.querySelector("#findRatio"),
  minReviews: document.querySelector("#minReviews"),
};

function newItem(name = "", mutation = "None", income = "") {
  return {
    name,
    searchQuery: name,
    custom: false,
    mutation,
    income,
    status: "idle",
    result: null,
    error: "",
    cacheTime: 0,
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
  const normalized = String(query || "").trim().toLowerCase();
  const options = normalized
    ? brainrots.filter((name) => name.toLowerCase().includes(normalized))
    : brainrots;
  const customLabel = String(query || "").trim();
  return `
    ${options.map((name) => `<button type="button" class="brainrot-option" data-brainrot="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("")}
    ${customLabel ? `<button type="button" class="brainrot-option custom-option" data-custom-brainrot="${escapeHtml(customLabel)}">Custom brainrot: ${escapeHtml(customLabel)}</button>` : ""}
    ${options.length || customLabel ? "" : `<span class="brainrot-empty">No matches</span>`}
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

function cents(value) {
  return Math.round(Number(value || 0) * 100);
}

function formatRatio(value, targetPrice, sourcePrice) {
  if (!Number.isFinite(value)) return "?";
  let decimals = 0;
  for (; decimals <= 8; decimals += 1) {
    const roundedRatio = Number(value.toFixed(decimals));
    if (cents(roundedRatio * targetPrice) === cents(sourcePrice)) break;
  }
  const fixed = value.toFixed(decimals).replace(/\.?0+$/, "");
  return fixed.includes(".") ? fixed : `${fixed}.0`;
}

function renderPicker(role) {
  const item = state[role];
  const container = role === "source" ? els.sourceRow : els.targetRow;
  container.innerHTML = `
    <label class="brainrot-picker">Brainrot
      <input class="brainrot-search" name="searchQuery" value="${escapeHtml(item.searchQuery)}" placeholder="Type: Dragon..." autocomplete="off" />
      <div class="brainrot-menu">${brainrotOptionsHtml(item.searchQuery)}</div>
    </label>
    <label>Mutation
      <select name="mutation">
        ${mutations.map((value) => `<option value="${escapeHtml(value)}" ${sameText(item.mutation, value) ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}
      </select>
    </label>
    <label>Income / sec
      <input name="income" value="${escapeHtml(item.income)}" placeholder="250M or 1.8B" />
    </label>
  `;
}

function resetItem(item) {
  item.status = "idle";
  item.result = null;
  item.error = "";
  item.cacheTime = 0;
  item.fromCache = false;
}

function readStoredCache() {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredCache(cache) {
  try {
    localStorage.setItem(PRICE_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Memory cache still works.
  }
}

function priceCacheKey(item) {
  const minReviews = Math.max(0, Number(els.minReviews.value || 0));
  const custom = item.custom || !findExactBrainrot(itemName(item)) ? "1" : "0";
  return `${itemName(item)}|${item.mutation}|${item.income}|reviews:${minReviews}|custom:${custom}`;
}

function getCachedPrice(key) {
  const memoryCached = state.cache.get(key);
  if (memoryCached && Date.now() - memoryCached.time <= PRICE_CACHE_MS) return memoryCached;
  if (memoryCached) state.cache.delete(key);

  const storedCache = readStoredCache();
  const storedCached = storedCache[key];
  if (storedCached && Date.now() - storedCached.time <= PRICE_CACHE_MS) {
    state.cache.set(key, storedCached);
    return storedCached;
  }
  if (storedCached) {
    delete storedCache[key];
    writeStoredCache(storedCache);
  }
  return null;
}

function setCachedPrice(key, result) {
  const entry = { result, time: Date.now() };
  state.cache.set(key, entry);
  const storedCache = readStoredCache();
  storedCache[key] = entry;
  writeStoredCache(storedCache);
  return entry;
}

function cacheAgeText(time) {
  const minutes = Math.floor(Math.max(0, Date.now() - time) / 60000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}

function updateRatio() {
  const sourceName = itemName(state.source);
  const targetName = itemName(state.target);
  const sourcePrice = state.source.result?.best?.price;
  const targetPrice = state.target.result?.best?.price;

  if (state.source.status === "loading" || state.target.status === "loading") {
    els.ratioValue.textContent = "Searching...";
    els.ratioText.textContent = "Checking Eldorado listings.";
    return;
  }

  if (state.source.error || state.target.error) {
    els.ratioValue.textContent = "No ratio";
    els.ratioText.textContent = state.source.error || state.target.error;
    return;
  }

  if (!sourceName || !targetName || !sourcePrice || !targetPrice) {
    els.ratioValue.textContent = "Find ratio";
    els.ratioText.textContent = `${sourceName || "Brainrot"} in price of ${targetName || "target"}`;
    return;
  }

  const ratio = sourcePrice / targetPrice;
  const formatted = formatRatio(ratio, targetPrice, sourcePrice);
  els.ratioValue.textContent = formatted;
  els.ratioText.textContent = `${sourceName} = ${formatted} x ${targetName}`;
}

function renderPriceRows() {
  const rows = [
    { label: "Your brainrot", item: state.source },
    { label: "Price target", item: state.target },
  ];
  els.priceRows.innerHTML = "";

  for (const { label, item } of rows) {
    const best = item.result?.best;
    const row = document.createElement("article");
    row.className = "price-row";

    if (item.status === "loading") {
      row.innerHTML = `<div><strong>${escapeHtml(itemName(item) || "Empty item")}</strong><span>${label}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income)}</span><strong>Searching...</strong><div><span>Checking current estimates.</span></div>`;
    } else if (best) {
      row.innerHTML = `
        <div><strong>${escapeHtml(itemName(item))}</strong><span>${label}</span></div>
        <span class="pill">${escapeHtml(item.mutation)}</span>
        <span>${escapeHtml(best.incomeRange || item.result.incomeRange)} - ${formatIncome(best.incomeNumber)}/s</span>
        <strong>${formatMoney(best.price)}</strong>
        <div><strong>${item.fromCache ? "Cached price" : "Matched price"}</strong><span>${item.fromCache ? `Searched ${cacheAgeText(item.cacheTime)}.` : "Used for ratio."}</span></div>
      `;
    } else if (item.error) {
      row.innerHTML = `<div><strong>${escapeHtml(itemName(item) || "Empty item")}</strong><span>${label}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income)}</span><strong>No price</strong><div><span>${escapeHtml(item.error)}</span></div>`;
    } else {
      row.innerHTML = `<div><strong>${escapeHtml(itemName(item) || "Empty item")}</strong><span>${label}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income || "income needed")}</span><strong>Not searched</strong><div><span>Press Find ratio.</span></div>`;
    }

    els.priceRows.append(row);
  }
}

function render() {
  renderPicker("source");
  renderPicker("target");
  renderPriceRows();
  updateRatio();
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
    item.cacheTime = cached.time;
    item.fromCache = true;
    return;
  }

  const minReviews = Math.max(0, Number(els.minReviews.value || 0));
  const custom = item.custom || !findExactBrainrot(name) ? "1" : "0";
  const params = new URLSearchParams({ name, mutation: item.mutation, income: item.income, minReviews, custom });
  const response = await fetch(`${API_BASE}/api/search?${params.toString()}`);
  const result = await response.json();
  const cacheEntry = setCachedPrice(key, result);
  item.result = result;
  item.status = result.best ? "done" : "error";
  item.error = result.best ? "" : result.error || "No matching price estimate found.";
  item.cacheTime = cacheEntry.time;
  item.fromCache = false;
}

async function findRatio() {
  els.findRatio.disabled = true;
  els.findRatio.textContent = "Searching...";
  for (const item of [state.source, state.target]) {
    item.status = "loading";
    item.error = "";
  }
  renderPriceRows();
  updateRatio();

  try {
    await Promise.all([lookupItem(state.source), lookupItem(state.target)]);
  } catch {
    for (const item of [state.source, state.target]) {
      if (item.status === "loading") {
        item.status = "error";
        item.error = "Price check failed. Try again.";
      }
    }
  } finally {
    els.findRatio.disabled = false;
    els.findRatio.textContent = "Find ratio";
    renderPriceRows();
    updateRatio();
  }
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
  const form = event.target.closest("form[data-role]");
  if (!form || !event.target.name) return;
  const item = state[form.dataset.role];

  if (event.target.name === "searchQuery") {
    item.searchQuery = event.target.value;
    item.name = item.custom ? "" : findExactBrainrot(event.target.value);
    const menu = event.target.closest(".brainrot-picker")?.querySelector(".brainrot-menu");
    if (menu) menu.innerHTML = brainrotOptionsHtml(event.target.value);
  } else {
    item[event.target.name] = event.target.value;
  }

  resetItem(item);
  renderPriceRows();
  updateRatio();
});

document.addEventListener("change", (event) => {
  const form = event.target.closest("form[data-role]");
  if (!form || !event.target.name || event.target.name === "searchQuery") return;
  const item = state[form.dataset.role];
  item[event.target.name] = event.target.value;
  resetItem(item);
  renderPriceRows();
  updateRatio();
});

document.addEventListener("pointerdown", (event) => {
  const option = event.target.closest(".brainrot-option");
  if (!option) return;
  event.preventDefault();
  const form = option.closest("form[data-role]");
  const item = state[form.dataset.role];
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
  render();
});

els.findRatio.addEventListener("click", findRatio);

loadOptions().finally(render);
