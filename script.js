const API_BASE = "http://localhost:4193";

let brainrots = [
  "Noobini Pizzanini",
  "Lirili Larila",
  "Tim Cheese",
  "Fluriflura",
  "Talpa Di Fero",
  "Svinina Bombardino",
  "Pipi Kiwi",
  "Trippi Troppi",
  "Tung Tung Tung Sahur",
  "Gangster Footera",
  "Boneca Ambalabu",
  "Brr Brr Patapim",
  "Ta Ta Ta Ta Sahur",
  "Tric Trac Baraboom",
  "Cappuccino Assassino",
  "Burbaloni Loliloli",
  "Chimpanzini Bananini",
  "Ballerina Cappuccina",
  "Chef Crabracadabra",
  "Frigo Camelo",
  "Orangutini Ananassini",
  "Rhino Toasterino",
  "Bombardiro Crocodilo",
  "Bombombini Gusini",
  "Cocofanto Elefanto",
  "Girafa Celestre",
  "Matteo",
  "Tralalero Tralala",
  "Odin Din Din Dun",
  "Unclito Samito",
  "La Vacca Saturno Saturnita",
  "Graipuss Medussi",
  "Los Tralaleritos",
  "Pot Hotspot",
  "Sammyni Spiderini",
  "Agarrini La Palini",
  "Garama and Madundung",
  "Dragon Cannelloni",
  "Cerberus",
  "Burguro and Fryuro",
  "Strawberry Elephant",
  "La Secret Combinasion",
  "Ketchuru And Musturu",
  "Capitano Moby",
  "Guest 666",
  "Meowl",
  "Hydra Bunny",
];

let mutations = ["None", "Gold", "Diamond", "Bloodrot", "Candy", "Lava", "Galaxy", "Yin-Yang", "Radioactive", "Rainbow"];

const state = {
  you: [],
  them: [],
  cache: new Map(),
};

const els = {
  youRows: document.querySelector("#youRows"),
  themRows: document.querySelector("#themRows"),
  yourTotal: document.querySelector("#yourTotal"),
  theirTotal: document.querySelector("#theirTotal"),
  verdict: document.querySelector("#verdict"),
  matches: document.querySelector("#matches"),
  lookupAll: document.querySelector("#lookupAll"),
  minReviews: document.querySelector("#minReviews"),
};

function newItem(name = "", income = "", mutation = "None", quantity = 1, customName = "") {
  return {
    id: crypto.randomUUID(),
    name,
    customName,
    income,
    mutation,
    quantity,
    status: "idle",
    result: null,
    error: "",
  };
}

function getItemName(item) {
  return item.name === "__custom" ? item.customName.trim() : item.name;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function formatMoney(value) {
  if (value === null || value === undefined) return "?";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
}

function formatIncome(value) {
  if (!value) return "unknown";
  if (value >= 1e12) return `${Number((value / 1e12).toFixed(2))}T`;
  if (value >= 1e9) return `${Number((value / 1e9).toFixed(2))}B`;
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(2))}M`;
  return String(value);
}

function listingLine(listing) {
  return `${formatMoney(listing.price)} - ${formatIncome(listing.incomeNumber)}/s - ${listing.seller} (${Math.round(listing.ratingCount || 0)} reviews)`;
}

function renderRows(side) {
  const container = side === "you" ? els.youRows : els.themRows;
  container.innerHTML = "";
  state[side].forEach((item) => {
    const itemName = getItemName(item);
    const query = item.searchQuery ?? itemName;
    const options = query
      ? brainrots.filter((name) => name.toLowerCase().startsWith(query.toLowerCase())).slice(0, 12)
      : brainrots.slice(0, 12);
    const row = document.createElement("div");
    row.className = "item-row";
    row.dataset.id = item.id;
    row.innerHTML = `
      <label class="brainrot-picker">Brainrot
        <input class="brainrot-search" name="searchQuery" value="${escapeHtml(query)}" placeholder="Type: si" autocomplete="off" />
        <input type="hidden" name="name" value="${escapeHtml(item.name)}" />
        <div class="brainrot-menu">
          ${options.map((name) => `<button type="button" class="brainrot-option" data-brainrot="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("")}
          <button type="button" class="brainrot-option custom-option" data-brainrot="__custom">Custom...</button>
        </div>
      </label>
      <label class="${item.name === "__custom" ? "" : "hidden"}">Custom name
        <input name="customName" value="${escapeHtml(item.customName)}" placeholder="Brainrot name" />
      </label>
      <label>Mutation
        <select name="mutation">
          ${mutations.map((mutation) => `<option value="${mutation}" ${item.mutation === mutation ? "selected" : ""}>${mutation}</option>`).join("")}
        </select>
      </label>
      <label>Income / sec
        <input name="income" value="${escapeHtml(item.income)}" placeholder="1.8B or 750M" />
      </label>
      <label>Qty
        <input name="quantity" type="number" min="1" value="${item.quantity}" />
      </label>
      <button class="remove" type="button" title="Remove">x</button>
    `;
    container.appendChild(row);
  });
}

function brainrotOptionsHtml(query) {
  const options = query
    ? brainrots.filter((name) => name.toLowerCase().startsWith(query.toLowerCase())).slice(0, 12)
    : brainrots.slice(0, 12);
  return `
    ${options.map((name) => `<button type="button" class="brainrot-option" data-brainrot="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("")}
    <button type="button" class="brainrot-option custom-option" data-brainrot="__custom">Custom...</button>
  `;
}

function itemValue(item) {
  const price = item.result?.best?.price;
  if (!price) return null;
  return price * Number(item.quantity || 1);
}

function calculateSide(side) {
  let total = 0;
  let missing = 0;
  state[side].forEach((item) => {
    const value = itemValue(item);
    if (value === null) missing += 1;
    else total += value;
  });
  return { total, missing };
}

function updateTotals() {
  const your = calculateSide("you");
  const their = calculateSide("them");
  els.yourTotal.textContent = your.missing ? `${formatMoney(your.total)} + ?` : formatMoney(your.total);
  els.theirTotal.textContent = their.missing ? `${formatMoney(their.total)} + ?` : formatMoney(their.total);

  els.verdict.className = "verdict";
  if (your.missing || their.missing) {
    els.verdict.textContent = "Find prices";
    return;
  }
  if (!your.total && !their.total) {
    els.verdict.textContent = "Add offers";
    return;
  }

  const diff = their.total - your.total;
  const fairBand = Math.max(2, Math.max(your.total, their.total) * 0.06);
  if (Math.abs(diff) <= fairBand) {
    els.verdict.textContent = "FAIR";
    els.verdict.classList.add("fair");
  } else if (diff > 0) {
    els.verdict.textContent = `W +${formatMoney(diff)}`;
    els.verdict.classList.add("win");
  } else {
    els.verdict.textContent = `L ${formatMoney(diff)}`;
    els.verdict.classList.add("loss");
  }
}

function renderMatches() {
  const allItems = [
    ...state.you.map((item) => ({ ...item, side: "Your offer" })),
    ...state.them.map((item) => ({ ...item, side: "Their offer" })),
  ];

  els.matches.innerHTML = "";
  allItems.forEach((item) => {
    const itemName = getItemName(item);
    const best = item.result?.best;
    const card = document.createElement("article");
    card.className = "match-card";

    if (item.status === "loading") {
      card.innerHTML = `<div><strong>${escapeHtml(itemName || "Empty item")}</strong><span>${item.side}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income)}</span><strong>Searching...</strong><div><span>Checking Eldorado low to high.</span></div>`;
    } else if (best) {
      const alternatives = (item.result.alternatives || []).slice(1, 4);
      card.innerHTML = `
        <div><strong>${escapeHtml(itemName)}</strong><span>${item.side} - qty ${item.quantity}</span></div>
        <span class="pill">${escapeHtml(item.mutation)}</span>
        <span>${escapeHtml(item.result.incomeRange)} - ${formatIncome(best.incomeNumber)}/s</span>
        <strong>${formatMoney(best.price)}</strong>
        <div>
          <strong>${escapeHtml(best.title)}</strong>
          <span>${escapeHtml(best.seller)} - ${Math.round(best.ratingCount || 0)} reviews - ${Number(best.rating || 0).toFixed(1)}% - ${escapeHtml(item.result.searchMode || "market search")}</span>
          ${alternatives.length ? `<span class="alternatives">Other found: ${alternatives.map((listing) => escapeHtml(listingLine(listing))).join(" | ")}</span>` : ""}
        </div>
      `;
    } else if (item.error) {
      card.innerHTML = `<div><strong>${escapeHtml(itemName || "Empty item")}</strong><span>${item.side}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income)}</span><strong>No price</strong><div><span>${escapeHtml(item.error)}</span></div>`;
    } else {
      card.innerHTML = `<div><strong>${escapeHtml(itemName || "Empty item")}</strong><span>${item.side}</span></div><span class="pill">${escapeHtml(item.mutation)}</span><span>${escapeHtml(item.income || "income needed")}</span><strong>Not searched</strong><div><span>Press Find prices.</span></div>`;
    }

    els.matches.appendChild(card);
  });
}

function render() {
  renderRows("you");
  renderRows("them");
  updateTotals();
  renderMatches();
}

function updateFromInput(side, id, field, value) {
  const item = state[side].find((entry) => entry.id === id);
  if (!item) return;
  if (field === "searchQuery") {
    item.searchQuery = value;
    item.name = "";
    item.customName = "";
  } else {
  item[field] = field === "quantity" ? Math.max(1, Number(value || 1)) : value;
  }
  item.result = null;
  item.error = "";
  item.status = "idle";
  updateTotals();
  renderMatches();
}

async function lookupItem(item) {
  const name = getItemName(item);
  if (!name || !item.income) {
    item.error = "Choose brainrot and income first.";
    item.status = "error";
    return;
  }

  const minReviews = Math.max(0, Number(els.minReviews.value || 0));
  const custom = item.name === "__custom" ? "1" : "0";
  const cacheKey = `${name}|${item.mutation}|${item.income}|reviews:${minReviews}|custom:${custom}`;
  if (state.cache.has(cacheKey)) {
    item.result = state.cache.get(cacheKey);
    item.status = item.result.best ? "done" : "error";
    item.error = item.result.best ? "" : "No matching Eldorado listing found.";
    return;
  }

  item.status = "loading";
  renderMatches();
  updateTotals();

  const params = new URLSearchParams({ name, mutation: item.mutation, income: item.income, minReviews, custom });
  const response = await fetch(`${API_BASE}/api/search?${params.toString()}`);
  const result = await response.json();
  state.cache.set(cacheKey, result);
  item.result = result;
  item.status = result.best ? "done" : "error";
  item.error = result.best ? "" : result.error || "No matching Eldorado listing found.";
}

async function lookupAll() {
  els.lookupAll.disabled = true;
  els.lookupAll.textContent = "Searching...";
  const items = [...state.you, ...state.them];
  try {
    for (const item of items) {
      await lookupItem(item);
      render();
    }
  } catch (error) {
    items.forEach((item) => {
      if (item.status === "loading") {
        item.status = "error";
        item.error = "Local server is not running. Open START_CALCULATOR.bat, then press Find prices again.";
      }
    });
  } finally {
    els.lookupAll.disabled = false;
    els.lookupAll.textContent = "Find prices";
    render();
  }
}

async function loadOptions() {
  try {
    const response = await fetch(`${API_BASE}/api/options`);
    const options = await response.json();
    if (Array.isArray(options.brainrots) && options.brainrots.length) brainrots = options.brainrots;
    if (Array.isArray(options.mutations) && options.mutations.length) mutations = options.mutations;
  } catch {
    // Keep fallback lists if the local server is not running yet.
  }
}

document.addEventListener("input", (event) => {
  const row = event.target.closest(".item-row");
  const form = event.target.closest("form[data-side]");
  if (!row || !form || !event.target.name) return;
  updateFromInput(form.dataset.side, row.dataset.id, event.target.name, event.target.value);
  if (event.target.name === "searchQuery") {
    const menu = row.querySelector(".brainrot-menu");
    if (menu) menu.innerHTML = brainrotOptionsHtml(event.target.value);
  }
});

document.addEventListener("change", (event) => {
  const row = event.target.closest(".item-row");
  const form = event.target.closest("form[data-side]");
  if (!row || !form || !event.target.name) return;
  updateFromInput(form.dataset.side, row.dataset.id, event.target.name, event.target.value);
  if (event.target.name === "name") render();
});

document.addEventListener("click", (event) => {
  const option = event.target.closest(".brainrot-option");
  if (option) {
    const row = option.closest(".item-row");
    const form = option.closest("form[data-side]");
    const item = state[form.dataset.side].find((entry) => entry.id === row.dataset.id);
    if (!item) return;
    item.name = option.dataset.brainrot;
    item.searchQuery = option.dataset.brainrot === "__custom" ? "" : option.dataset.brainrot;
    item.customName = "";
    item.result = null;
    item.error = "";
    item.status = "idle";
    render();
    return;
  }

  const addButton = event.target.closest("[data-add]");
  if (addButton) {
    state[addButton.dataset.add].push(newItem());
    render();
    return;
  }

  const removeButton = event.target.closest(".remove");
  if (removeButton) {
    const row = removeButton.closest(".item-row");
    const form = removeButton.closest("form[data-side]");
    state[form.dataset.side] = state[form.dataset.side].filter((item) => item.id !== row.dataset.id);
    render();
  }
});

els.lookupAll.addEventListener("click", lookupAll);

state.you.push(newItem("Hydra Bunny", "1.3B", "Diamond", 1));
state.them.push(newItem("Dragon Cannelloni", "1.8B", "Diamond", 1));
loadOptions().finally(render);
