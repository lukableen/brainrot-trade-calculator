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
const MIN_MARKET_REVIEWS = 1000;
const VERIFY_IMAGE_INCOME = true;
const OFFER_IMAGE_BASE = "https://assetsdelivery.eldorado.gg/v7/_offers-v2_/";
const OCR_LANG = "eng";
const REQUIRED_MUTATIONS = ["Phantom", "Crystal"];

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

const fallbackLibraryPath = path.join(root, "brainrot-library.json");
let libraryCache = null;
let libraryCacheTime = 0;
const marketCache = new Map();
const sellerCache = new Map();
const marketLinkCache = new Map();
const imageIncomeCache = new Map();
const MARKET_CACHE_MS = 10 * 60 * 1000;
const ELDORADO_REQUEST_SPACING_MS = 100;
const SEARCH_PAGE_SIZE = 50;
const SEARCH_MAX_PAGES = 80;
const SEARCH_PAGE_BATCH_SIZE = 4;
const VERIFY_LIMIT = 30;
const VERIFY_BATCH_SIZE = 5;
let nextEldoradoRequestAt = 0;
let ocrWorkerPromise = null;

function loadTesseract() {
  try {
    return require("tesseract.js");
  } catch {
    return require("C:/Users/lukab/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/tesseract.js@7.0.0/node_modules/tesseract.js");
  }
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    const { createWorker } = loadTesseract();
    ocrWorkerPromise = createWorker(OCR_LANG);
  }
  return ocrWorkerPromise;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sameName(a, b) {
  return normalize(a) === normalize(b);
}

function withRequiredMutations(values) {
  const result = Array.isArray(values) && values.length ? [...values] : ["None"];
  for (const mutation of REQUIRED_MUTATIONS) {
    if (!result.some((item) => sameName(item, mutation))) result.push(mutation);
  }
  return result;
}

function normalizeMutation(value) {
  const normalized = normalize(value === "base" || value === "default" ? "none" : value || "none");
  if (normalized === "phsntom") return "phantom";
  return normalized;
}

function parseIncome(value) {
  const clean = String(value || "").toUpperCase().replace(",", ".");
  const match = clean.match(/(\d+(?:\.\d+)?)\s*(K|M|B|T|THOUSAND|MILLION|MILLIONS|BILLION|BILLIONS|BILL|TRILLION|TRILLIONS)?(?:\s*\/?\s*S)?/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const multipliers = {
    K: 1e3,
    THOUSAND: 1e3,
    M: 1e6,
    MILLION: 1e6,
    MILLIONS: 1e6,
    B: 1e9,
    BILLION: 1e9,
    BILLIONS: 1e9,
    BILL: 1e9,
    T: 1e12,
    TRILLION: 1e12,
    TRILLIONS: 1e12,
  };
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

function rangesAtOrAboveIncome(income) {
  const wantedRange = rangeForIncome(income);
  if (!wantedRange) return [null];
  const startIndex = rangeIndex(wantedRange);
  return INCOME_RANGES.slice(Math.max(0, startIndex));
}

function rangeForLabel(label) {
  return INCOME_RANGES.find((range) => sameName(range[0], label)) || null;
}

function rangeIndex(range) {
  return INCOME_RANGES.findIndex((item) => item === range || sameName(item[0], range?.[0] || range));
}

function isIncomeInsideRange(income, range) {
  if (!income || !range) return false;
  return income >= range[2] && income <= range[3];
}

function effectiveRangeUpper(range) {
  if (!range) return Infinity;
  if (Number.isFinite(range[3])) return range[3];
  if (/B\/s/i.test(range[0])) return 999.99e9;
  if (/M\/s/i.test(range[0])) return 999.99e6;
  if (/K\/s/i.test(range[0])) return 999.99e3;
  return Infinity;
}

function normalizeIncomeToRange(income, range) {
  if (!income || !range) return income || 0;
  if (range[2] === 0 && range[3] === 0) return income === 0 ? 0 : 0;

  const lower = range[2] * 0.9;
  const upper = effectiveRangeUpper(range) * 1.1;
  const candidates = [income, income / 10, income / 100];
  return candidates.find((candidate) => candidate >= lower && candidate <= upper) || 0;
}

function normalizeIncomeToOfferRange(offer, income) {
  const range = rangeForLabel(getAttributeValue(offer, "M/s"));
  return normalizeIncomeToRange(income, range);
}

function getTradeValue(offer, name) {
  return offer.tradeEnvironmentValues?.find((value) => sameName(value.name, name))?.value || "";
}

function getAttribute(offer, name) {
  return offer.attributes?.find((attribute) => sameName(attribute.name, name));
}

function getAttributeValue(offer, name) {
  const value = getAttribute(offer, name)?.value;
  return value?.name ?? value ?? "";
}

function offerIncomeNumber(offer, preferTextIncome = false) {
  const msRange = getAttribute(offer, "M/s")?.value?.name || "";
  const range = rangeForLabel(msRange);
  const textIncome = extractIncomeFromOfferText(offer, msRange);
  const textRangeIncome = normalizeIncomeToOfferRange(offer, textIncome);
  if (preferTextIncome && textRangeIncome > 0) return textRangeIncome;

  const numeric = Number(offer.attributes?.find((attribute) => attribute.id === "steal-a-brainrot-ms-numeric")?.value);
  if (!Number.isFinite(numeric)) return normalizeIncomeToRange(textRangeIncome || textIncome, range);

  const scaledValue = numeric * multiplierForRangeLabel(msRange);
  const scaledRangeIncome = normalizeIncomeToRange(scaledValue, range);
  if (scaledRangeIncome > 0) return scaledRangeIncome;

  const rawRangeIncome = normalizeIncomeToRange(numeric, range);
  if (rawRangeIncome > 0) return rawRangeIncome;
  if (!range && numeric > 0) return scaledValue || numeric;
  return textRangeIncome;
}

function multiplierForRangeLabel(label) {
  if (/T\/s/i.test(label)) return 1e12;
  if (/B\/s/i.test(label)) return 1e9;
  if (/M\/s/i.test(label)) return 1e6;
  if (/K\/s/i.test(label)) return 1e3;
  return 1;
}

function extractIncomeFromOfferText(offer, rangeLabel = "") {
  const text = `${offer.offerTitle || ""} ${offer.description || ""}`.replace(/,/g, ".");
  const values = [];

  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(K|M|B|T|THOUSAND|MILLION|MILLIONS|BILLION|BILLIONS|BILL|TRILLION|TRILLIONS)\b(?:\s*\/?\s*S|\s*PER\s*SEC|\s*PER\s*SECOND|\s*A\s*SEC|\s*SEC|\s*SECOND)?/gi)) {
    values.push(parseIncome(`${match[1]}${match[2]}`));
  }

  const inferredMultiplier = multiplierForRangeLabel(rangeLabel);
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*S\b/gi)) {
    values.push(Number(match[1]) * inferredMultiplier);
  }

  if (!values.length) return 0;
  return Math.max(...values);
}

function getOfferImageUrl(offer) {
  const image =
    offer.mainOfferImage?.originalSizeImage ||
    offer.mainOfferImage?.largeImage ||
    offer.offerImages?.[0]?.originalSizeImage ||
    offer.offerImages?.[0]?.largeImage ||
    "";
  if (!image) return "";
  if (/^https?:\/\//i.test(image)) return image;
  return `${OFFER_IMAGE_BASE}${image}`;
}

function matchedImageIncomeNumber(row, imageIncome) {
  if (!row.incomeNumber || !imageIncome) return false;
  const range = rangeForLabel(row.msRange || row.incomeRange || "");
  const candidates = [imageIncome, imageIncome / 10, imageIncome / 100]
    .map((candidate) => normalizeIncomeToRange(candidate, range) || candidate);
  return candidates.find((candidate) => {
    const bigger = Math.max(row.incomeNumber, candidate);
    const smaller = Math.min(row.incomeNumber, candidate);
    return smaller / bigger >= INCOME_TOLERANCE;
  }) || 0;
}

async function getImageIncomeNumber(offer) {
  const imageUrl = getOfferImageUrl(offer);
  if (!imageUrl) return { imageUrl, imageIncomeNumber: 0, imageVerified: false, imageCheck: "missing-image" };

  const cached = imageIncomeCache.get(imageUrl);
  if (cached && Date.now() - cached.time < MARKET_CACHE_MS) return cached.value;

  try {
    const worker = await getOcrWorker();
    const result = await worker.recognize(imageUrl);

    const text = result.data?.text || "";
    const imageIncomeNumber = normalizeIncomeToOfferRange(offer, parseImageIncome(text));
    const value = {
      imageUrl,
      imageIncomeNumber,
      imageIncome: formatIncome(imageIncomeNumber),
      imageOcrText: text.replace(/\s+/g, " ").trim().slice(0, 240),
      imageVerified: imageIncomeNumber > 0,
      imageCheck: imageIncomeNumber > 0 ? "read" : "no-income-in-image",
    };
    imageIncomeCache.set(imageUrl, { time: Date.now(), value });
    return value;
  } catch (error) {
    ocrWorkerPromise = null;
    return {
      imageUrl,
      imageIncomeNumber: 0,
      imageIncome: "unknown",
      imageVerified: false,
      imageCheck: `ocr-failed: ${error.message}`,
    };
  }
}

function parseImageIncome(text) {
  const normalized = String(text || "")
    .replace(/[,，]/g, ".")
    .replace(/[|]/g, "1")
    .replace(/\b8\/s\b/gi, "B/s");
  const values = [];
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*(K|M|B|T|THOUSAND|MILLION|MILLIONS|BILLION|BILLIONS|BILL|TRILLION|TRILLIONS)\b(?:\s*\/?\s*S)?/gi)) {
    values.push(parseIncome(`${match[1]}${match[2]}`));
  }
  return values.length ? Math.max(...values) : 0;
}

function offerMutation(offer) {
  return getAttribute(offer, "Mutations")?.value?.name || "None";
}

function mutationMatches(offer, mutation) {
  return normalizeMutation(offerMutation(offer)) === normalizeMutation(mutation);
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

  if (offerIncome > 0) return offerIncome >= wanted;
  if (wantedRange && offerRangeInfo) return rangeIndex(offerRangeInfo) >= rangeIndex(wantedRange);
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
  const incomeRange = getAttribute(offer, "M/s")?.value?.name || "unknown";
  const incomeRangeInfo = rangeForLabel(incomeRange);
  return {
    id: offer.id,
    name: getTradeValue(offer, "Brainrot"),
    rarity: getTradeValue(offer, "Rarity"),
    mutation: offerMutation(offer),
    incomeRange,
    incomeNumber: normalizeIncomeToRange(offerIncomeNumber(offer, preferTextIncome), incomeRangeInfo),
    title: offer.offerTitle,
    description: offer.description,
    rating: result.userOrderInfo?.feedbackScore || 0,
    ratingCount: result.userOrderInfo?.ratingCount || 0,
    delivery: offer.guaranteedDeliveryTime,
    price: offer.pricePerUnitInUSD?.amount ?? offer.pricePerUnit?.amount ?? 0,
    currency: offer.pricePerUnitInUSD?.currency || offer.pricePerUnit?.currency || "USD",
  };
}

function extractProfileSlug(profileUrl) {
  const raw = String(profileUrl || "").trim();
  if (!raw) return "";

  try {
    const parsed = raw.includes("://") ? new URL(raw) : new URL(`https://www.eldorado.gg/${raw.replace(/^\/+/, "")}`);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const usersIndex = parts.findIndex((part) => sameName(part, "users"));
    if (usersIndex !== -1 && parts[usersIndex + 1]) return decodeURIComponent(parts[usersIndex + 1]);
  } catch {
    // Fall through to a loose text extraction.
  }

  const match = raw.match(/users\/([^/?#]+)/i);
  return decodeURIComponent(match?.[1] || raw.replace(/^@/, ""));
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

async function resolveSeller(profileUrl) {
  const slug = extractProfileSlug(profileUrl);
  if (!slug) throw new Error("Paste an Eldorado seller profile link.");
  if (looksLikeUuid(slug)) return { id: slug, username: slug };

  try {
    const profile = await eldoradoGet(`users/${encodeURIComponent(slug)}/publicByUsername`);
    if (profile?.id) {
      return {
        id: profile.id,
        username: profile.username || slug,
        positiveFeedback: profile.positiveFeedbackPercentage,
        totalOrders: profile.totalOrders,
      };
    }
  } catch {
    // Eldorado no longer exposes every username through this endpoint.
  }

  return { username: slug, usernameOnly: true };
}

function sellerOfferToRow(result) {
  const offer = result.offer || result;
  const price = Number(offer.pricePerUnitInUSD?.amount ?? offer.pricePerUnit?.amount ?? 0);
  return {
    id: offer.id,
    title: offer.offerTitle || "Untitled offer",
    brainrot: getTradeValue(offer, "Brainrot") || offer.offerTitle || "Unknown item",
    rarity: getTradeValue(offer, "Rarity") || "unknown",
    mutation: getAttributeValue(offer, "Mutations") || "None",
    incomeRange: getAttributeValue(offer, "M/s") || "unknown",
    incomeNumber: offerIncomeNumber(offer, true),
    delivery: offer.guaranteedDeliveryTime,
    quantity: Number(offer.quantity || 0),
    price,
    currency: offer.pricePerUnitInUSD?.currency || offer.pricePerUnit?.currency || "USD",
    seller: result.user?.username || "",
    ratingCount: result.userOrderInfo?.ratingCount || 0,
    feedbackScore: result.userOrderInfo?.feedbackScore || 0,
    imageUrl: getOfferImageUrl(offer),
    url: `https://www.eldorado.gg/steal-a-brainrot-brainrots/oi/${offer.id}`,
  };
}

function extractMarketUrl(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) throw new Error("Paste an Eldorado market link.");

  try {
    const parsed = raw.includes("://") ? new URL(raw) : new URL(`https://www.eldorado.gg/${raw.replace(/^\/+/, "")}`);
    if (!/eldorado\.gg$/i.test(parsed.hostname) && !/\.eldorado\.gg$/i.test(parsed.hostname)) {
      throw new Error("Use an Eldorado market link.");
    }
    return parsed;
  } catch (error) {
    if (error.message) throw error;
    throw new Error("Paste a valid Eldorado market link.");
  }
}

function buildMarketLinkRequestParams(marketUrl, pageIndex, pageSize) {
  const parts = marketUrl.pathname.split("/").filter(Boolean);
  const categoryMarker = parts[parts.length - 2];
  const gameId = parts[parts.length - 1];

  if (categoryMarker !== "i" || gameId !== GAME_ID) {
    throw new Error("Use a Steal a Brainrot item market link ending in /i/259.");
  }

  const requestParams = {
    gameId: GAME_ID,
    category: CATEGORY,
    pageIndex,
    pageSize,
    includeDeliveryMedians: "true",
    "numericAttributeFilters[0].attributeId": "steal-a-brainrot-ms-numeric",
  };

  const passthroughKeys = new Set([
    "searchQuery",
    "hotSearchQuery",
    "deliveryTime",
    "offerSortingCriterion",
    "isAscending",
  ]);

  for (const [key, value] of marketUrl.searchParams.entries()) {
    if (!value || key === "gamePageOfferIndex" || key === "gamePageOfferSize") continue;
    if (key === "te_v0") requestParams.tradeEnvironmentValue0 = value;
    else if (key === "te_v1") requestParams.tradeEnvironmentValue1 = value;
    else if (key === "te_v2") requestParams.tradeEnvironmentValue2 = value;
    else if (key === "attr_ids") requestParams.offerAttributeIdsCsv = value;
    else if (key.startsWith("steal-a-brainrot-") || passthroughKeys.has(key)) requestParams[key] = value;
  }

  return requestParams;
}

function marketPriceRange(marketUrl) {
  const lowest = Number(marketUrl.searchParams.get("lowestPrice") || "");
  const highest = Number(marketUrl.searchParams.get("highestPrice") || "");
  return {
    lowest: Number.isFinite(lowest) ? lowest : 0,
    highest: Number.isFinite(highest) && highest > 0 ? highest : Infinity,
  };
}

function priceInsideRange(row, range) {
  const price = Number(row.price || 0);
  return price >= range.lowest && price <= range.highest;
}

async function marketOfferToIncomeRow(result, verifyImage) {
  const offer = result.offer || result;
  const row = sellerOfferToRow(result);
  const imageCheck = verifyImage ? await getImageIncomeNumber(offer) : {};
  const imageMatchedIncomeNumber = verifyImage ? matchedImageIncomeNumber(row, imageCheck.imageIncomeNumber || 0) : row.incomeNumber;
  const imageVerified = verifyImage ? imageMatchedIncomeNumber > 0 : true;
  const imageRejected = verifyImage && (imageCheck.imageIncomeNumber || 0) > 0 && !imageVerified;
  const incomeNumber = imageVerified && imageMatchedIncomeNumber ? imageMatchedIncomeNumber : row.incomeNumber;
  return {
    ...row,
    ...imageCheck,
    imageMatchedIncomeNumber,
    imageVerified,
    imageRejected,
    incomeNumber,
    income: formatIncome(incomeNumber),
    line: `${row.brainrot} · ${row.mutation} · ${formatIncome(incomeNumber)} · ${new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: row.currency || "USD",
      maximumFractionDigits: 2,
    }).format(row.price || 0)}`,
  };
}

async function getMarketIncomeOffers(params) {
  const marketUrl = extractMarketUrl(params.get("url") || "");
  const minReviews = Math.max(0, Number(params.get("minReviews") || MIN_MARKET_REVIEWS));
  const verifyImage = params.get("verifyImage") !== "0";
  const priceRange = marketPriceRange(marketUrl);
  const pageSize = 50;
  const maxPages = 200;
  const cacheKey = `${marketUrl.toString().replace(/([?&])gamePageOffer(Index|Size)=[^&]*/g, "$1")}|reviews:${minReviews}|image:${verifyImage}`;
  const cached = marketLinkCache.get(cacheKey);
  if (cached && Date.now() - cached.time < MARKET_CACHE_MS) return cached.value;

  const rows = [];
  const seenIds = new Set();
  let recordCount = 0;
  let pagesScanned = 0;
  let totalPages = 1;

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
    const requestParams = buildMarketLinkRequestParams(marketUrl, pageIndex, pageSize);
    const data = await eldoradoGet("v1/item-management/offers", requestParams);

    recordCount = data.recordCount || recordCount;
    totalPages = data.totalPages || totalPages;
    pagesScanned = pageIndex;

    for (const result of data.results || []) {
      const offer = result.offer || result;
      if (!offer?.id || seenIds.has(offer.id)) continue;
      if ((result.userOrderInfo?.ratingCount || 0) < minReviews) continue;
      const basicRow = sellerOfferToRow(result);
      if (!priceInsideRange(basicRow, priceRange)) continue;
      seenIds.add(offer.id);
      const row = await marketOfferToIncomeRow(result, verifyImage);
      if (verifyImage && row.imageRejected) continue;
      rows.push(row);
    }

    if (pageIndex >= totalPages) break;
  }

  rows.sort((a, b) => {
    const incomeDiff = (b.incomeNumber || 0) - (a.incomeNumber || 0);
    if (incomeDiff) return incomeDiff;
    return (a.price || 0) - (b.price || 0);
  });

  const value = {
    ok: true,
    sourceUrl: marketUrl.toString(),
    recordCount,
    minReviews,
    verifyImage,
    priceRange,
    pagesScanned,
    totalPages,
    results: rows,
  };
  marketLinkCache.set(cacheKey, { time: Date.now(), value });
  return value;
}

async function getSellerOffers(params) {
  const profileUrl = params.get("profile") || "";
  const minPrice = Math.max(0, Number(params.get("minPrice") || 0));
  const cacheKey = normalize(`${profileUrl}|${minPrice}`);
  const cached = sellerCache.get(cacheKey);
  if (cached && Date.now() - cached.time < MARKET_CACHE_MS) return cached.value;

  const seller = await resolveSeller(profileUrl);
  const pageSize = 50;
  const maxPages = seller.usernameOnly ? 40 : 200;
  const rows = [];
  let recordCount = 0;
  let pagesScanned = 0;
  let seenSeller = false;

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
    const requestParams = {
      gameId: GAME_ID,
      category: CATEGORY,
      pageIndex,
      pageSize,
      offerSortingCriterion: "Price",
      isAscending: "false",
      includeDeliveryMedians: "true",
    };
    if (seller.id) requestParams.userId = seller.id;

    const data = await eldoradoGet("v1/item-management/offers", requestParams);

    recordCount = data.recordCount || recordCount;
    pagesScanned = pageIndex;
    const results = seller.usernameOnly
      ? (data.results || []).filter((result) => sameName(result.user?.username, seller.username))
      : (data.results || []);
    if (results.length) seenSeller = true;

    rows.push(
      ...results
        .map(sellerOfferToRow)
        .filter((row) => row.price >= minPrice)
        .filter((row) => row.quantity > 0 || row.quantity === 0)
    );

    if (pageIndex >= (data.totalPages || 1)) break;
    if (seller.usernameOnly && seenSeller && pageIndex >= 8 && !results.length) break;
  }

  const value = {
    ok: true,
    seller,
    profileUrl: `https://www.eldorado.gg/users/${seller.id || seller.username}/shop/CustomItem`,
    recordCount,
    pagesScanned,
    scannedByUsername: Boolean(seller.usernameOnly),
    results: rows.sort((a, b) => b.price - a.price || a.brainrot.localeCompare(b.brainrot)),
  };
  sellerCache.set(cacheKey, { time: Date.now(), value });
  return value;
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
    nextEldoradoRequestAt = Date.now() + ELDORADO_REQUEST_SPACING_MS;

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
  const wantedRange = rangeForIncome(wantedIncome);
  const sorted = [...listings].sort((a, b) => a.price - b.price || a.incomeNumber - b.incomeNumber);
  const atOrAbove = wanted
    ? sorted.filter((listing) => (listing.incomeNumber || 0) >= wanted)
    : sorted;
  const sameRange = wantedRange
    ? atOrAbove.filter((listing) => sameName(listing.incomeRange, wantedRange[0]))
    : atOrAbove;
  const pool = sameRange.length ? sameRange : atOrAbove;
  const cheapest = pool[0]?.price || 0;
  const valueBandExtra = Math.max(1.25, Math.min(3, cheapest * 0.75));
  const valueBand = cheapest ? pool.filter((listing) => listing.price <= cheapest + valueBandExtra) : pool;
  const queue = [...valueBand]
    .sort((a, b) => a.price - b.price || a.incomeNumber - b.incomeNumber || b.ratingCount - a.ratingCount)
    .concat(pool.filter((listing) => !valueBand.includes(listing)))
    .slice(0, VERIFY_LIMIT);
  const verified = [];

  for (let index = 0; index < queue.length && verified.length < 5; index += VERIFY_BATCH_SIZE) {
    const batch = queue.slice(index, index + VERIFY_BATCH_SIZE);
    const detailsList = await Promise.all(batch.map((listing) => getActiveOfferDetails(listing.id)));
    detailsList.forEach((details, batchIndex) => {
      if (!details || verified.length >= 5) return;
      const listing = batch[batchIndex];
      verified.push({ ...toListing(details, listing.searchMode === "search items"), searchMode: listing.searchMode });
    });
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

function getFallbackLibrary() {
  try {
    const data = JSON.parse(fs.readFileSync(fallbackLibraryPath, "utf8"));
    return {
      brainrots: Array.isArray(data.brainrots) ? data.brainrots : [],
      mutations: withRequiredMutations(data.mutations),
      fallback: true,
    };
  } catch {
    return { brainrots: [], mutations: withRequiredMutations(["None"]), fallback: true };
  }
}

async function getLibrary() {
  if (libraryCache && Date.now() - libraryCacheTime < 15 * 60 * 1000) return libraryCache;
  try {
    const data = await eldoradoGet(`library/${GAME_ID}/${CATEGORY}`, { locale: "en-US" });
    const mutationAttribute = data.attributes?.find((attribute) => attribute.name === "Mutations");
    libraryCache = {
      brainrots: collectBrainrots(data.tradeEnvironments),
      mutations: withRequiredMutations(mutationAttribute?.attributeValues?.map((value) => value.name)),
      fallback: false,
    };
  } catch {
    libraryCache = getFallbackLibrary();
  }
  libraryCacheTime = Date.now();
  return libraryCache;
}

async function searchMarket(params) {
  const name = params.get("name") || "";
  const mutation = params.get("mutation") || "None";
  const income = params.get("income") || "";
  const minReviews = Math.max(0, Number(params.get("minReviews") || 0));
  const forceSearchItems = params.get("custom") === "1";
  const cacheKey = normalize(`${name}|${mutation}|${income}|${minReviews}|${forceSearchItems ? "custom" : "known"}|full-fast-v1`);
  const cached = marketCache.get(cacheKey);
  if (cached && Date.now() - cached.time < MARKET_CACHE_MS) return cached.value;

  const library = await getLibrary();
  const isKnownBrainrot = !forceSearchItems && library.brainrots.some((brainrot) => sameName(brainrot, name));
  const pageSize = SEARCH_PAGE_SIZE;
  const maxPages = SEARCH_MAX_PAGES;
  const wantedRange = rangeForIncome(income);
  let scanned = 0;
  let pagesScanned = 0;
  let seen = 0;
  let matchedCount = 0;
  let best = null;
  let alternatives = [];
  let usedIncomeRange = wantedRange?.[0] || "any";
  const rangesToSearch = [wantedRange || null];

  for (const searchRange of rangesToSearch) {
    const candidates = [];
    const seenIds = new Set();

    async function readSearchPage(pageIndex) {
      const requestParams = {
        gameId: GAME_ID,
        category: CATEGORY,
        searchQuery: name,
        pageIndex,
        pageSize,
        offerSortingCriterion: "Price",
        isAscending: "true",
        includeDeliveryMedians: "true",
        "numericAttributeFilters[0].attributeId": "steal-a-brainrot-ms-numeric",
      };
      return eldoradoGet("v1/item-management/offers", requestParams);
    }

    function collectMatches(data) {
      scanned += data.results?.length || 0;
      pagesScanned += 1;
      seen += data.recordCount || 0;
      const matches = (data.results || [])
        .filter((result) => !seenIds.has(result.offer?.id))
        .filter((result) => matchesBrainrot(result.offer, name, isKnownBrainrot))
        .filter((result) => forceSearchItems || !hasWrongBrainrotInText(result.offer, name, library.brainrots))
        .filter((result) => mutationMatches(result.offer, mutation))
        .filter((result) => incomeMatches(result.offer, income, forceSearchItems))
        .filter((result) => !hasRobuxExtraPayment(result.offer))
        .filter((result) => !hasRandomBrainrotOfferText(result.offer))
        .filter((result) => (result.userOrderInfo?.ratingCount || 0) >= minReviews)
        .map((result) => {
          seenIds.add(result.offer?.id);
          return { ...toListing(result, forceSearchItems), searchMode: searchRange ? `income range ${searchRange[0]}` : "search items" };
        })
        .sort((a, b) => a.price - b.price);

      candidates.push(...matches);
    }

    const firstPage = await readSearchPage(1);
    collectMatches(firstPage);
    const totalPages = Math.min(maxPages, firstPage.totalPages || 1);

    for (let pageIndex = 2; pageIndex <= totalPages; pageIndex += SEARCH_PAGE_BATCH_SIZE) {
      const batchPages = [];
      for (let offset = 0; offset < SEARCH_PAGE_BATCH_SIZE && pageIndex + offset <= totalPages; offset += 1) {
        batchPages.push(pageIndex + offset);
      }
      const batchData = await Promise.all(batchPages.map((page) => readSearchPage(page)));
      batchData.forEach(collectMatches);
    }

    matchedCount += candidates.length;
    const verified = await chooseBestVerifiedOffers(candidates, income);
    if (verified.best) {
      best = verified.best;
      alternatives = verified.alternatives;
      usedIncomeRange = searchRange?.[0] || wantedRange?.[0] || "any";
      break;
    }
  }

  const value = {
    ok: Boolean(best),
    best,
    alternatives,
    scanned,
    matchedCount,
    recordCount: seen,
    pagesScanned,
    incomeRange: usedIncomeRange,
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
    if (url.pathname === "/api/seller-offers") {
      sendJson(res, 200, await getSellerOffers(url.searchParams));
      return;
    }
    if (url.pathname === "/api/market-income-offers") {
      sendJson(res, 200, await getMarketIncomeOffers(url.searchParams));
      return;
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
    return;
  }

  serveFile(req, res);
});

server.listen(port, () => {
  console.log(`Brainrot Ratio Finder running at http://localhost:${port}`);
});
