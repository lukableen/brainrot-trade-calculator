const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = process.env.PORT || 4173;
const API_BASE = "https://www.eldorado.gg/api/";
const GAME_ID = "259";
const CATEGORY = "CustomItem";
const INCOME_TOLERANCE = 0.98;
const INCOME_RANGES = [
  ["0", "0", 0, 0],
  ["1-999.99 K/s", "1-99999-ks", 1e3, 999.99e3],
  ["1-24.99 M/s", "1-2499-ms", 1e6, 24.99e6],
  ["25-49.99 M/s", "25-4999-ms", 25e6, 49.99e6],
  ["50-99.99 M/s", "50-9999-ms", 50e6, 99.99e6],
  ["100-249.99 M/s", "100-24999-ms", 100e6, 249.99e6],
  ["250-499.99 M/s", "250-49999-ms", 250e6, 499.99e6],
  ["500-749.99 M/s", "500-74999-ms", 500e6, 749.99e6],
  ["750-999.99 M/s", "750-99999-ms", 750e6, 999.99e6],
  ["1-4.99 B/s", "1-499-bs", 1e9, 4.99e9],
  ["5-9.99 B/s", "5-999-bs", 5e9, 9.99e9],
  ["10-19.99 B/s", "10-1999-bs", 10e9, 19.99e9],
  ["20+ B/s", "20-bs", 20e9, Infinity],
];

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

let libraryCache = null;
let libraryCacheTime = 0;
const marketCache = new Map();
const MARKET_CACHE_MS = 10 * 60 * 1000;
let nextEldoradoRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sameName(a, b) {
  return normalize(a) === normalize(b);
}

function parseIncome(value) {
  const clean = String(value || "").toUpperCase().replace(",", ".");
  const match = clean.match(/(\d+(?:\.\d+)?)\s*([KMBT])?(?:\s*\/?\s*S)?/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return amount * (multipliers[match[2]] || 1);
}

function formatIncome(value) {
  if (!value) return "unknown";
  if (value >= 1e12) return `${Number((value / 1e12).toFixed(2))}T`;
  if (value >= 1e9) return `${Number((value / 1e9).toFixed(2))}B`;
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(2))}M`;
  if (value >= 1e3) return `${Number((value / 1e3).toFixed(2))}K`;
  return `${Number(value.toFixed(2))}`;
}

function rangeForIncome(income) {
  const value = parseIncome(income);
  return INCOME_RANGES.find((range) => value >= range[2] && value <= range[3]) || null;
}

function rangeForLabel(label) {
  return INCOME_RANGES.find((range) => sameName(range[0], label)) || null;
}

function isIncomeInsideRange(income, range) {
  if (!income || !range) return false;
  return income >= range[2] && income <= range[3];
}

function getTradeValue(offer, name) {
  return offer.tradeEnvironmentValues?.find((value) => sameName(value.name, name))?.value || "";
}

function getAttribute(offer, name) {
  return offer.attributes?.find((attribute) => sameName(attribute.name, name));
}

function offerIncomeNumber(offer, preferTextIncome = false) {
  const textIncome = extractIncomeFromOfferText(offer);
  if (preferTextIncome && textIncome > 0) return textIncome;

  const msRange = getAttribute(offer, "M/s")?.value?.name || "";
  const numeric = Number(offer.attributes?.find((attribute) => attribute.id === "steal-a-brainrot-ms-numeric")?.value);
  if (!Number.isFinite(numeric)) return textIncome;
  if (/B\/s/i.test(msRange)) return numeric * 1e9;
  if (/M\/s/i.test(msRange)) return numeric * 1e6;
  if (/K\/s/i.test(msRange)) return numeric * 1e3;
  if (numeric > 0) return numeric;
  return textIncome;
}

function extractIncomeFromOfferText(offer) {
  const text = `${offer.offerTitle || ""} ${offer.description || ""}`.replace(/,/g, ".");
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([KMBT])?\s*(?:\/?\s*S|PER\s*SEC|PER\s*SECOND|A\s*SEC|SEC|SECOND)/gi)];
  if (!matches.length) return 0;
  return Math.max(...matches.map((match) => parseIncome(`${match[1]}${match[2] || ""}`)));
}

function offerMutation(offer) {
  return getAttribute(offer, "Mutations")?.value?.name || "None";
}

function mutationMatches(offer, mutation) {
  const wanted = normalize(mutation === "base" ? "none" : mutation || "none");
  return normalize(offerMutation(offer)) === wanted;
}

function matchesBrainrot(offer, name, isKnownBrainrot) {
  const tradeValue = getTradeValue(offer, "Brainrot");
  if (isKnownBrainrot) return sameName(tradeValue, name);

  const text = normalize(`${tradeValue} ${offer.offerTitle || ""} ${offer.description || ""}`);
  return normalize(name)
    .split(" ")
    .filter(Boolean)
    .every((word) => text.includes(word));
}

function hasWrongBrainrotInText(offer, wantedName, brainrots) {
  const rawText = `${offer.offerTitle || ""} ${offer.description || ""}`;
  const text = normalize(rawText);
  if (!text) return false;

  const wanted = normalize(wantedName);
  const mentioned = brainrots
    .map((brainrot) => normalize(brainrot))
    .filter((brainrot) => brainrot && brainrot !== wanted && brainrot.length >= 6)
    .some((brainrot) => text.includes(brainrot));

  return mentioned && !text.includes(wanted);
}

function hasRobuxExtraPayment(offer) {
  const text = normalize(`${offer.offerTitle || ""} ${offer.description || ""}`);
  const patterns = [
    /you need add \d* robux/,
    /need add \d* robux/,
    /need to add \d* robux/,
    /add \d* robux/,
    /requires? \d* robux/,
    /donate \d* robux/,
    /pay \d* robux/,
    /robux first/,
    /robux payment/,
    /game pass/,
    /gamepass/,
    /before delivery.*robux/,
    /before.*delivered.*robux/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function hasRandomBrainrotOfferText(offer) {
  const text = normalize(`${offer.offerTitle || ""} ${offer.description || ""}`);
  const patterns = [
    /speed rush alert/,
    /speed rush/,
    /random brainrot/,
    /random secret brainrot/,
    /mystery brainrot/,
    /mystery secret/,
    /secret brainrot.*random/,
    /random.*secret brainrot/,
    /random item/,
    /random drop/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function incomeMatches(offer, wantedIncome, preferTextIncome = false) {
  const wanted = parseIncome(wantedIncome);
  if (!wanted) return true;
  const wantedRange = rangeForIncome(wantedIncome);
  const offerRange = getAttribute(offer, "M/s")?.value?.name || "";
  const offerRangeInfo = rangeForLabel(offerRange);
  const offerIncome = offerIncomeNumber(offer, preferTextIncome);

  if (preferTextIncome) {
    return offerIncome > 0 && offerIncome >= wanted;
  }

  if (wantedRange && !sameName(offerRange, wantedRange[0])) return false;
  if (offerIncome > 0) return offerIncome >= wanted && isIncomeInsideRange(offerIncome, offerRangeInfo);
  if (wantedRange) return sameName(offerRange, wantedRange[0]);
  return false;
}

function chooseCheapestAtOrAboveIncome(listings, wantedIncome) {
  const wanted = parseIncome(wantedIncome);
  if (!wanted) {
    return listings.sort((a, b) => a.price - b.price)[0] || null;
  }

  const atOrAbove = listings.filter((listing) => (listing.incomeNumber || 0) >= wanted);
  if (atOrAbove.length) return atOrAbove.sort((a, b) => a.price - b.price || a.incomeNumber - b.incomeNumber)[0];

  return listings
    .map((listing) => ({ ...listing, incomeDistance: Math.abs((listing.incomeNumber || 0) - wanted) }))
    .sort((a, b) => a.incomeDistance - b.incomeDistance || a.price - b.price)[0] || null;
}

function toListing(result, preferTextIncome = false) {
  const offer = result.offer;
  return {
    id: offer.id,
    name: getTradeValue(offer, "Brainrot"),
    rarity: getTradeValue(offer, "Rarity"),
    mutation: offerMutation(offer),
    incomeRange: getAttribute(offer, "M/s")?.value?.name || "unknown",
    incomeNumber: offerIncomeNumber(offer, preferTextIncome),
    title: offer.offerTitle,
    description: offer.description,
    rating: result.userOrderInfo?.feedbackScore || 0,
    ratingCount: result.userOrderInfo?.ratingCount || 0,
    delivery: offer.guaranteedDeliveryTime,
    price: offer.pricePerUnitInUSD?.amount ?? offer.pricePerUnit?.amount ?? 0,
    currency: offer.pricePerUnitInUSD?.currency || offer.pricePerUnit?.currency || "USD",
  };
}

async function eldoradoGet(endpoint, params) {
  const url = new URL(endpoint, API_BASE);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  const headers = {
    "accept": "application/json",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wait = Math.max(0, nextEldoradoRequestAt - Date.now());
    if (wait) await sleep(wait);
    nextEldoradoRequestAt = Date.now() + 450;

    const response = await fetch(url, { headers });
    if (response.ok) return response.json();

    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      await sleep(retryAfter ? retryAfter * 1000 : 1800 * (attempt + 1));
      continue;
    }

    if (response.status === 429) throw new Error("Price source is busy. Try again in a minute.");
    throw new Error(`Price check failed (${response.status})`);
  }

  throw new Error("Price source is busy. Try again in a minute.");
}

async function getActiveOfferDetails(offerId) {
  try {
    const data = await eldoradoGet(`v1/item-management/offers/${offerId}`);
    const offer = data.offer;
    if (!offer || offer.offerState !== "Active" || Number(offer.quantity || 0) < 1) return null;
    return data;
  } catch {
    return null;
  }
}

async function chooseBestVerifiedOffers(listings, wantedIncome) {
  const wanted = parseIncome(wantedIncome);
  const sorted = [...listings].sort((a, b) => a.price - b.price || a.incomeNumber - b.incomeNumber);
  const closeEnough = wanted
    ? sorted.filter((listing) => (listing.incomeNumber || 0) >= wanted)
    : sorted;
  const pool = closeEnough.length ? closeEnough : sorted;
  const cheapest = pool[0]?.price || 0;
  const valueBandExtra = Math.max(1.25, Math.min(3, cheapest * 0.75));
  const valueBand = cheapest ? pool.filter((listing) => listing.price <= cheapest + valueBandExtra) : pool;
  const queue = [...valueBand]
    .sort((a, b) => a.price - b.price || a.incomeNumber - b.incomeNumber || b.ratingCount - a.ratingCount)
    .concat(pool.filter((listing) => !valueBand.includes(listing)))
    .slice(0, 30);
  const verified = [];

  for (const listing of queue) {
    const details = await getActiveOfferDetails(listing.id);
    if (details) verified.push({ ...toListing(details, listing.searchMode === "search items"), searchMode: listing.searchMode });
    if (verified.length >= 5) break;
  }

  return { best: verified[0] || null, alternatives: verified };
}

function collectBrainrots(tradeEnvironments) {
  const names = [];
  function walk(node) {
    if (node.name === "Brainrot" && node.value && node.value !== "Other") names.push(node.value);
    node.childTradeEnvironments?.forEach(walk);
  }
  tradeEnvironments?.forEach(walk);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

async function getLibrary() {
  if (libraryCache && Date.now() - libraryCacheTime < 15 * 60 * 1000) return libraryCache;
  const data = await eldoradoGet(`library/${GAME_ID}/${CATEGORY}`, { locale: "en-US" });
  const mutationAttribute = data.attributes?.find((attribute) => attribute.name === "Mutations");
  libraryCache = {
    brainrots: collectBrainrots(data.tradeEnvironments),
    mutations: mutationAttribute?.attributeValues?.map((value) => value.name) || ["None"],
  };
  libraryCacheTime = Date.now();
  return libraryCache;
}

async function searchMarket(params) {
  const name = params.get("name") || "";
  const mutation = params.get("mutation") || "None";
  const income = params.get("income") || "";
  const minReviews = Math.max(0, Number(params.get("minReviews") || 0));
  const forceSearchItems = params.get("custom") === "1";
  const cacheKey = normalize(`${name}|${mutation}|${income}|${minReviews}|${forceSearchItems ? "custom" : "known"}`);
  const cached = marketCache.get(cacheKey);
  if (cached && Date.now() - cached.time < MARKET_CACHE_MS) return cached.value;

  const library = await getLibrary();
  const isKnownBrainrot = !forceSearchItems && library.brainrots.some((brainrot) => sameName(brainrot, name));
  const pageSize = 50;
  const maxPages = 80;
  const wantedRange = rangeForIncome(income);
  let scanned = 0;
  let pagesScanned = 0;
  let seen = 0;
  const candidates = [];

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
    const data = await eldoradoGet("v1/item-management/offers", {
      gameId: GAME_ID,
      category: CATEGORY,
      searchQuery: name,
      pageIndex,
      pageSize,
      offerSortingCriterion: "Price",
      isAscending: "true",
      includeDeliveryMedians: "true",
      "numericAttributeFilters[0].attributeId": "steal-a-brainrot-ms-numeric",
    });

    scanned += data.results?.length || 0;
    pagesScanned = pageIndex;
    seen = data.recordCount || seen;
    const matches = (data.results || [])
      .filter((result) => matchesBrainrot(result.offer, name, isKnownBrainrot))
      .filter((result) => forceSearchItems || !hasWrongBrainrotInText(result.offer, name, library.brainrots))
      .filter((result) => mutationMatches(result.offer, mutation))
      .filter((result) => incomeMatches(result.offer, income, forceSearchItems))
      .filter((result) => !hasRobuxExtraPayment(result.offer))
      .filter((result) => !hasRandomBrainrotOfferText(result.offer))
      .filter((result) => (result.userOrderInfo?.ratingCount || 0) >= minReviews)
      .map((result) => ({ ...toListing(result, forceSearchItems), searchMode: isKnownBrainrot ? "category filter" : "search items" }))
      .sort((a, b) => a.price - b.price);

    candidates.push(...matches);

    if (pageIndex >= (data.totalPages || 1)) break;
  }

  const { best, alternatives } = await chooseBestVerifiedOffers(candidates, income);

  const value = {
    ok: Boolean(best),
    best,
    alternatives,
    scanned,
    matchedCount: candidates.length,
    recordCount: seen,
    pagesScanned,
    incomeRange: wantedRange?.[0] || "any",
    minReviews,
    searchMode: isKnownBrainrot ? "category filter" : "search items",
    marketUrl: `https://www.eldorado.gg/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-for-sale/i/259`,
  };
  marketCache.set(cacheKey, { time: Date.now(), value });
  return value;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(root, requested));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname === "/api/options") {
      sendJson(res, 200, await getLibrary());
      return;
    }
    if (url.pathname === "/api/search") {
      sendJson(res, 200, await searchMarket(url.searchParams));
      return;
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
    return;
  }

  serveFile(req, res);
});

server.listen(port, () => {
  console.log(`Brainrot Trade Calculator running at http://localhost:${port}`);
});
