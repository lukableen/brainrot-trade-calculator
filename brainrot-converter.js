const API_BASE = window.location.origin;
const PRICE_CACHE_MS = 10 * 60 * 1000;
const PRICE_CACHE_STORAGE_KEY = "brainrot-price-cache-v1";

let brainrots = ["Garama and Madundung", "Dragon Cannelloni", "Signore Carapace", "Headless Horseman"];
let mutations = ["None", "Gold", "Diamond", "Bloodrot", "Candy", "Lava", "Galaxy", "Yin-Yang", "Radioactive", "Rainbow", "Phantom", "Crystal"];

const state = {
  source: newItem("Garama and Madundung", "1.8B", "None"),
  target: newItem("Dragon Cannelloni", "250M", "None"),
  cache: new Map(),
};

const els = {
  sourceRow: document.querySelector("#sourceRow"),
  targetRow: document.querySelector("#targetRow"),
  ratioValue: document.querySelector("#ratioValue"),
  ratioText: document.querySelector("#ratioText"),
  matches: document.querySelector("#matches"),
  lookupAll: document.querySelector("#lookupAll"),
  minReviews: document.querySelector("#minReviews"),
};

function newItem(name = "", income = "", mutation = "None") {
  return {
    name,
    income,
    mutation,
    searchQuery: name,
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

function getItemName(item) {
  return item.name.trim();
}

function findExactBrainrot(query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return "";
  return brainrots.find((name) => name.toLowerCase() === normalized) || "";
}

function formatMoney(value) {
  if (value === null || value === undefined) return "?";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value || 0);
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

function formatIncome(value) {
  if (!value) return "unknown";
  if (value >= 1e12) return `${Number((value / 1e12).toFixed(2))}T`;
  if (value >= 1e9) return `${Number((value / 1e9).toFixed(2))}B`;
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(2))}M`;
  if (value >= 1e3) return `${Number((value / 1e3).toFixed(2))}K`;
  return String(value);
}

function brainrotOptionsHtml(query) {
  const normalized = String(query || "").trim().toLowerCase();
  const options = normalized ? brainrots.filter((name) => name.toLowerCase().includes(normalized)) : brainrots;
  return `
    ${options.map((name) => `<button type="button" class="brainrot-option" data-brainrot="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("")}
    ${options.length ? "" : `<span class="brainrot-empty">No matches</span>`}
  `;
}

function renderRow(role) {
  const item = state[role];
  const container = role === "source" ? els.sourceRow : els.targetRow;
  const query = item.searchQuery ?? getItemName(item);
  container.innerHTML = `
    <label class="brainrot-picker">Brainrot
      <input class="brainrot-search" name="searchQuery" value="${escapeHtml(query)}" placeholder="Dragon..." autocomplete="off" />
      <div class="brainrot-menu">${brainrotOptionsHtml(query)}</div>
    </label>
    <label>Mutation
      <select name="mutation">
        ${mutations.map((mutation) => `<option value="${escapeHtml(mutation)}" ${item.mutation === mutation ? "selected" : ""}>${escapeHtml(mutation)}</option>`).join("")}
      </select>
    </label>
    <label>Income / sec
      <input name="income" value="${escapeHtml(item.income)}" placeholder="250M or 1.8B" />
    </label>
  `;
}

function resetResult(item) {
  item.result = null;
  item.error = "";
  item.status = "idle";
  item.cacheTime = 0;
  item.fromCache = false;
}

function priceCacheKey(item) {
  const minReviews = Math.max(0, Number(els.minReviews.value || 0));
  return `${getItemName(item)}|${item.mutation}|${item.income}|reviews:${minReviews}|custom:0`;
}

function readStoredPriceCache() {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredPriceCache(cache) {
  try {
    localStorage.setItem(PRICE_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // In-memory cache still works if browser storage is unavailable.
  }
}

function getCachedPrice(cacheKey) {
  const memoryCached = state.cache.get(cacheKey);
  if (memoryCached && Date.now() - memoryCached.time <= PRICE_CACHE_MS) return memoryCached;
  if (memoryCached) state.cache.delete(cacheKey);

  const storedCache = readStoredPriceCache();
  const storedCached = storedCache[cacheKey];
  if (storedCached && Date.now() - storedCached.time <= PRICE_CACHE_MS) {
    state.cache.set(cacheKey, storedCached);
    return storedCached;
  }
  if (storedCached) {
    delete storedCache[cacheKey];
    writeStoredPriceCache(storedCache);
  }
  return null;
}

function setCachedPrice(cacheKey, result) {
  const entry = { result, time: Date.now() };
  state.cache.set(cacheKey, entry);

  const storedCache = readStoredPriceCache();
  storedCache[cacheKey] = entry;
  writeStoredPriceCache(storedCache);
  return entry;
}

function cacheAgeText(time) {
  if (!time) return "";
  const minutes = Math.floor(Math.max(0, Date.now() - time) / 60000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}

function ensureMutationOptions() {
  for (const mutation of ["Phantom", "Crystal"]) {
    if (!mutations.some((item) => item.toLowerCase() === mutation.toLowerCase())) {
      mutations.push(mutation);
    }
  }
}

function updateRatio() {
  const sourceName = getItemName(state.source);
  const targetName = getItemName(state.target);
  const sourcePrice = state.source.result?.best?.price;
  const targetPrice = state.target.result?.best?.price;

  if (!sourceName || !targetName) {
    els.ratioValue.textContent = "Choose brainrots";
    els.ratioText.textContent = "Pick one brainrot and the brainrot price you want to compare with.";
    return;
  }

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

  if (!sourcePrice || !targetPrice) {
    els.ratioValue.textContent = "Find ratio";
    els.ratioText.textContent = `${sourceName} in price of ${targetName}`;
    return;
  }

  const ratio = sourcePrice / targetPrice;
  const formattedRatio = formatRatio(ratio, targetPrice, sourcePrice);
  els.ratioValue.textContent = formattedRatio;
  els.ratioText.textContent = `${sourceName} = ${formattedRatio} x ${targetName}`;
}

function renderMatches() {
  const rows = [
    { label: "Your brainrot", item: state.source },
    { label: "Price target", item: state.target },
  ];

  els.matches.innerHTML = "";
  rows.forEach(({ label, item }) => {
    const itemName = getItemName(item);
    const best = item.result?.best;
    const card = document.createElement("article");
    card.className = "match-card";

    if (item.status === "loading") {
      card.innerHTML = `<div><strong>${escapeHtml(itemName || "Empty item")}</strong><span>${label}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income)}</span><strong>Searching...</strong><div><span>Checking current estimates.</span></div>`;
    } else if (best) {
      card.innerHTML = `
        <div><strong>${escapeHtml(itemName)}</strong><span>${label}</span></div>
        <span class="pill">${escapeHtml(item.mutation)}</span>
        <span>${escapeHtml(item.result.incomeRange)} - ${formatIncome(best.incomeNumber)}/s</span>
        <strong>${formatMoney(best.price)}</strong>
        <div>
          <strong>${item.fromCache ? "Cached price" : "Matched price"}</strong>
          <span>${item.fromCache ? `Searched ${cacheAgeText(item.cacheTime)}.` : "Used for exact division."}</span>
        </div>
      `;
    } else if (item.error) {
      card.innerHTML = `<div><strong>${escapeHtml(itemName || "Empty item")}</strong><span>${label}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income)}</span><strong>No price</strong><div><span>${escapeHtml(item.error)}</span></div>`;
    } else {
      card.innerHTML = `<div><strong>${escapeHtml(itemName || "Empty item")}</strong><span>${label}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income || "income needed")}</span><strong>Not searched</strong><div><span>Press Find ratio.</span></div>`;
    }

    els.matches.appendChild(card);
  });
}

function render() {
  renderRow("source");
  renderRow("target");
  updateRatio();
  renderMatches();
}

function updateFromInput(role, field, value) {
  const item = state[role];
  if (field === "searchQuery") {
    item.searchQuery = value;
    item.name = findExactBrainrot(value);
  } else {
    item[field] = value;
  }
  resetResult(item);
  updateRatio();
  renderMatches();
}

async function lookupItem(item) {
  const name = getItemName(item);
  if (!name || !item.income) {
    item.error = "Choose brainrot and income first.";
    item.status = "error";
    return;
  }

  const cacheKey = priceCacheKey(item);
  const cached = getCachedPrice(cacheKey);
  if (cached) {
    item.result = cached.result;
    item.status = item.result.best ? "done" : "error";
    item.error = item.result.best ? "" : "No matching price estimate found.";
    item.cacheTime = cached.time;
    item.fromCache = true;
    return;
  }

  item.status = "loading";
  updateRatio();
  renderMatches();

  const minReviews = Math.max(0, Number(els.minReviews.value || 0));
  const params = new URLSearchParams({ name, mutation: item.mutation, income: item.income, minReviews, custom: "0" });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let result;
  try {
    const response = await fetch(`${API_BASE}/api/search?${params.toString()}`, { signal: controller.signal });
    result = await response.json();
  } finally {
    clearTimeout(timeout);
  }

  const cacheEntry = setCachedPrice(cacheKey, result);
  item.result = result;
  item.status = result.best ? "done" : "error";
  item.error = result.best ? "" : result.error || "No matching price estimate found.";
  item.cacheTime = cacheEntry.time;
  item.fromCache = false;
}

async function lookupAll() {
  els.lookupAll.disabled = true;
  els.lookupAll.textContent = "Searching...";
  [state.source, state.target].forEach((item) => {
    item.status = "loading";
    item.error = "";
  });
  updateRatio();
  renderMatches();

  try {
    await Promise.all([lookupItem(state.source), lookupItem(state.target)]);
  } catch {
    [state.source, state.target].forEach((item) => {
      if (item.status === "loading") {
        item.status = "error";
        item.error = "Price check took too long. Try again.";
      }
    });
  } finally {
    els.lookupAll.disabled = false;
    els.lookupAll.textContent = "Find ratio";
    updateRatio();
    renderMatches();
  }
}

async function loadOptions() {
  try {
    const response = await fetch(`${API_BASE}/api/options`);
    const options = await response.json();
    if (Array.isArray(options.brainrots) && options.brainrots.length) brainrots = options.brainrots;
    if (Array.isArray(options.mutations) && options.mutations.length) mutations = options.mutations;
    ensureMutationOptions();
  } catch {
    try {
      const response = await fetch("brainrot-library.json");
      const options = await response.json();
      if (Array.isArray(options.brainrots) && options.brainrots.length) brainrots = options.brainrots;
      if (Array.isArray(options.mutations) && options.mutations.length) mutations = options.mutations;
      ensureMutationOptions();
    } catch {
      // Keep inline fallback.
      ensureMutationOptions();
    }
  }
}

document.addEventListener("input", (event) => {
  const form = event.target.closest("form[data-role]");
  if (!form || !event.target.name) return;
  updateFromInput(form.dataset.role, event.target.name, event.target.value);
  if (event.target.name === "searchQuery") {
    const menu = form.querySelector(".brainrot-menu");
    if (menu) menu.innerHTML = brainrotOptionsHtml(event.target.value);
  }
});

document.addEventListener("change", (event) => {
  const form = event.target.closest("form[data-role]");
  if (!form || !event.target.name || event.target.name === "searchQuery") return;
  updateFromInput(form.dataset.role, event.target.name, event.target.value);
});

function chooseBrainrotOption(option) {
  const form = option.closest("form[data-role]");
  const item = state[form.dataset.role];
  item.name = option.dataset.brainrot;
  item.searchQuery = option.dataset.brainrot;
  resetResult(item);
  render();
}

document.addEventListener("pointerdown", (event) => {
  const option = event.target.closest(".brainrot-option");
  if (!option) return;
  event.preventDefault();
  chooseBrainrotOption(option);
});

document.addEventListener("click", (event) => {
  const option = event.target.closest(".brainrot-option");
  if (option) chooseBrainrotOption(option);
});

els.lookupAll.addEventListener("click", lookupAll);
loadOptions().finally(render);
