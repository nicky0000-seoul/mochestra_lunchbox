// 카카오 지도 + 장소 검색 API 사용
// 키는 config.js 의 KAKAO_APP_KEY, 도메인은 카카오 개발자 콘솔 › 플랫폼 › Web 에 등록

const DEFAULT_POS = { lat: 37.566826, lng: 126.9786567 }; // 서울시청
const NEARBY_RADIUS = 2000; // 내 주변 식당 검색 반경(m)
const FOOD = "FD6"; // 카카오 카테고리 코드: 음식점

const SORTS = [
  { key: "distance", label: "거리순" },
  { key: "accuracy", label: "정확도순" },
];
const CATEGORIES = ["전체", "한식", "분식", "중식", "일식", "양식", "도시락"];

// 카카오 카테고리 이름(예: "음식점 > 한식 > 국수")으로 썸네일 이모지 선택
const EMOJIS = [
  ["도시락", "🍱"], ["분식", "🍙"], ["치킨", "🍗"], ["패스트푸드", "🍔"], ["피자", "🍕"],
  ["일식", "🍣"], ["중식", "🥟"], ["양식", "🍝"], ["아시아", "🍜"], ["술집", "🍺"],
  ["간식", "🍩"], ["국수", "🍜"], ["한식", "🍚"],
];

const state = {
  sdk: "loading", // loading | ready | error
  sdkError: null, // nokey | load
  loc: "locating", // locating | ready | denied | default(위치 없이 둘러보기)
  locError: null,
  pos: null,
  loading: true,
  loadingMore: false,
  sort: "distance",
  category: "전체",
  nearby: [],
  nearbyPage: null,
  nearbyError: false,
  mapItems: [],
  mapLoading: false,
  mapError: false,
  moved: false, // 지도를 옮겼는지 → "이 지역에서 다시 검색" 표시
  selected: null,
};

const $ = (sel) => document.querySelector(sel);

const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

function distanceBetween(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const toLatLng = (p) => new kakao.maps.LatLng(p.lat, p.lng);

// 카카오 응답 → 화면에서 쓰는 모양
function normalize(p) {
  const parts = p.category_name.split(" > ");
  const place = {
    id: p.id,
    name: p.place_name,
    category: parts.slice(1).join(" › ") || "음식점",
    emoji: (EMOJIS.find(([k]) => p.category_name.includes(k)) || [, "🍽️"])[1],
    address: p.road_address_name || p.address_name,
    phone: p.phone,
    url: /^https?:\/\//.test(p.place_url) ? p.place_url : null,
    lat: Number(p.y),
    lng: Number(p.x),
  };
  place.distance = p.distance ? Number(p.distance) : state.pos ? distanceBetween(state.pos, place) : null;
  return place;
}

// ───────── 탭 ─────────
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", t === tab));
    $("#view-nearby").hidden = tab.dataset.view !== "nearby";
    $("#view-map").hidden = tab.dataset.view !== "map";
    if (tab.dataset.view === "map") showMap();
  });
});

// ───────── 카카오 SDK 불러오기 ─────────
function loadSdk() {
  return new Promise((resolve, reject) => {
    const key = window.KAKAO_APP_KEY;
    if (!key || key.includes("여기에")) return reject("nokey");

    const timer = setTimeout(() => reject("load"), 10000);
    const script = document.createElement("script");
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
    script.onload = () => {
      if (!window.kakao?.maps) {
        clearTimeout(timer);
        return reject("load");
      }
      kakao.maps.load(() => {
        clearTimeout(timer);
        resolve();
      });
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject("load");
    };
    document.head.appendChild(script);
  });
}

// ───────── 현재 위치 ─────────
function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ error: "unsupported" });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ pos: { lat: p.coords.latitude, lng: p.coords.longitude } }),
      (err) => resolve({ error: err.code === err.PERMISSION_DENIED ? "denied" : "unavailable" }),
      { timeout: 8000, maximumAge: 60000 }
    );
  });
}

async function locate() {
  state.loc = "locating";
  state.loading = true;
  render();
  const result = await getPosition();
  if (result.pos) {
    state.loc = "ready";
    state.pos = result.pos;
  } else {
    state.loc = "denied";
    state.locError = result.error;
    state.pos = null;
  }
}

// 위치가 바뀐 뒤 목록과 지도를 새로 검색
function refreshForPosition() {
  if (state.sdk !== "ready") return;
  if (state.pos) searchNearby();
  else {
    state.loading = false;
    render();
  }
  if (map) {
    updateMe();
    suppressMove(() => map.setCenter(toLatLng(mapCenter())));
    searchMap();
  }
}

// ───────── 화면 1: 내 주변 식당 검색 ─────────
let nearbyReq = 0;

function searchNearby() {
  if (state.sdk !== "ready" || !state.pos) return;
  const req = ++nearbyReq;
  state.loading = true;
  state.nearbyError = false;
  render();

  const query = $("#nearby-search").value.trim();
  const keyword = [query, state.category === "전체" ? "" : state.category].filter(Boolean).join(" ");
  const { SortBy, Status } = kakao.maps.services;
  const options = {
    location: toLatLng(state.pos),
    radius: NEARBY_RADIUS,
    sort: state.sort === "distance" ? SortBy.DISTANCE : SortBy.ACCURACY,
  };

  const done = (data, status, pagination) => {
    if (req !== nearbyReq) return; // 더 새로운 검색이 시작됐으면 무시
    state.loading = false;
    state.loadingMore = false;
    if (status === Status.OK) {
      const items = data.map(normalize);
      state.nearby = pagination.current > 1 ? state.nearby.concat(items) : items;
      state.nearbyPage = pagination;
    } else if (status === Status.ZERO_RESULT) {
      state.nearby = [];
      state.nearbyPage = null;
    } else {
      state.nearby = [];
      state.nearbyPage = null;
      state.nearbyError = true;
    }
    render();
  };

  const places = new kakao.maps.services.Places();
  if (keyword) places.keywordSearch(keyword, done, { ...options, category_group_code: FOOD });
  else places.categorySearch(FOOD, done, options);
}

function loadMoreNearby() {
  if (!state.nearbyPage?.hasNextPage || state.loadingMore) return;
  state.loadingMore = true;
  renderNearby();
  state.nearbyPage.nextPage(); // 결과는 searchNearby 의 done 으로 들어옴
}

function renderChips() {
  $("#sort-chips").innerHTML = SORTS.map(
    (s) => `<button class="chip" role="radio" data-sort="${s.key}" aria-checked="${state.sort === s.key}">${s.label}</button>`
  ).join("");
  $("#category-chips").innerHTML = CATEGORIES.map(
    (c) => `<button class="chip" role="radio" data-category="${c}" aria-checked="${state.category === c}">${c}</button>`
  ).join("");
}

$(".chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  if (chip.dataset.sort) state.sort = chip.dataset.sort;
  if (chip.dataset.category) state.category = chip.dataset.category;
  renderChips();
  searchNearby();
});

let typingTimer;
$("#nearby-search").addEventListener("input", () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(searchNearby, 400);
});

// ───────── 공통 카드 정보 ─────────
function infoHTML(r) {
  return `
    <div class="info">
      <h3>${esc(r.name)}</h3>
      <p class="meta">${esc(r.category)}${r.distance != null ? ` · ${formatDistance(r.distance)}` : ""}</p>
      <p class="sub">
        <span>${esc(r.address)}</span>
        ${r.phone ? `<span>${esc(r.phone)}</span>` : ""}
        ${r.url ? `<a class="link" href="${esc(r.url)}" target="_blank" rel="noopener">카카오맵에서 보기 ↗</a>` : ""}
      </p>
    </div>`;
}

function noticeHTML(icon, title, desc, actions = "") {
  return `
    <div class="notice">
      <div class="icon">${icon}</div>
      <h2>${title}</h2>
      <p>${desc}</p>
      ${actions ? `<div class="actions">${actions}</div>` : ""}
    </div>`;
}

const SDK_ERRORS = {
  nokey: ["카카오 JavaScript 키가 필요해요", "config.js 파일에 카카오 개발자 콘솔의 JavaScript 키를 넣고 새로고침해 주세요."],
  load: [
    "카카오 지도를 불러오지 못했어요",
    `카카오 개발자 콘솔에서 ① <b>카카오맵 사용 설정</b>이 ON 인지, ② JavaScript SDK 도메인에 <b>${esc(location.origin)}</b> 이 등록돼 있는지, ③ JavaScript 키가 맞는지 확인해 주세요.`,
  ],
};

// ───────── 화면 1 그리기 ─────────
function renderNearby() {
  const body = $("#nearby-body");

  if (state.sdk === "error") {
    const [title, desc] = SDK_ERRORS[state.sdkError];
    body.innerHTML = noticeHTML("🗺️", title, desc);
    return;
  }

  if (state.loc === "denied") {
    const [title, desc] = {
      denied: ["위치 권한이 필요해요", "브라우저 설정에서 위치 접근을 허용하면 내 주변 식당을 거리순으로 보여드려요."],
      unavailable: ["현재 위치를 찾지 못했어요", "GPS 신호가 약하거나 네트워크가 불안정할 수 있어요. 잠시 후 다시 시도해 주세요."],
      unsupported: ["위치 기능을 쓸 수 없어요", "이 브라우저는 위치 기능을 지원하지 않아요."],
    }[state.locError];
    body.innerHTML = noticeHTML(
      "📍",
      title,
      desc,
      `<button class="btn primary" data-action="retry-location">다시 시도</button>
       <button class="btn" data-action="browse">위치 없이 둘러보기</button>`
    );
    return;
  }

  if (state.loading || state.sdk === "loading") {
    const caption = state.loc === "locating" ? "현재 위치를 확인하고 있어요…" : "주변 식당을 불러오고 있어요…";
    body.innerHTML =
      `<p class="loading-caption">${caption}</p><ul class="result-list">` +
      Array.from({ length: 4 }, () => `
        <li class="result skeleton" aria-hidden="true">
          <div class="thumb"></div>
          <div class="info"><div class="line mid"></div><div class="line short"></div><div class="line"></div></div>
        </li>`).join("") +
      `</ul>`;
    return;
  }

  if (state.nearbyError) {
    body.innerHTML = noticeHTML(
      "⚠️",
      "식당 정보를 불러오지 못했어요",
      "카카오 개발자 콘솔에서 카카오맵 사용 설정이 켜져 있는지, 사이트 도메인이 등록돼 있는지 확인해 주세요.",
      `<button class="btn primary" data-action="retry-search">다시 시도</button>`
    );
    return;
  }

  const banner =
    state.loc === "default"
      ? `<div class="banner">기본 위치(서울시청) 기준으로 보여드리고 있어요 <button data-action="retry-location">내 위치 사용</button></div>`
      : "";

  if (!state.nearby.length) {
    const query = $("#nearby-search").value.trim();
    const what = query ? `‘${esc(query)}’에 맞는` : state.category === "전체" ? "주변에" : `주변에 ${state.category}`;
    body.innerHTML =
      banner +
      noticeHTML(
        "🍽️",
        `${what} 식당이 없어요`,
        `반경 ${NEARBY_RADIUS / 1000}km 안에서 찾지 못했어요. 다른 검색어를 입력하거나 필터를 바꿔 보세요.`,
        `<button class="btn primary" data-action="reset-filters">필터 초기화</button>`
      );
    return;
  }

  const more = state.nearbyPage?.hasNextPage
    ? `<button class="btn more" data-action="more" ${state.loadingMore ? "disabled" : ""}>${state.loadingMore ? "불러오는 중…" : "더 보기"}</button>`
    : "";

  body.innerHTML = `${banner}<ul class="result-list">${state.nearby
    .map(
      (r) => `
      <li class="result ${r.id === state.selected?.id ? "selected" : ""}" data-id="${r.id}">
        <div class="thumb" aria-hidden="true">${r.emoji}</div>
        ${infoHTML(r)}
      </li>`
    )
    .join("")}</ul>${more}`;
}

$("#nearby-body").addEventListener("click", async (e) => {
  if (e.target.closest("a")) return; // "카카오맵에서 보기" 링크는 그대로 열기

  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "retry-location") {
    await locate();
    return refreshForPosition();
  }
  if (action === "browse") {
    state.loc = "default";
    state.pos = DEFAULT_POS;
    return refreshForPosition();
  }
  if (action === "retry-search") return searchNearby();
  if (action === "more") return loadMoreNearby();
  if (action === "reset-filters") {
    $("#nearby-search").value = "";
    state.category = "전체";
    renderChips();
    return searchNearby();
  }

  const li = e.target.closest(".result:not(.skeleton)");
  if (li) select(state.nearby.find((r) => r.id === li.dataset.id));
});

// ───────── 화면 2: 지도 ─────────
let map = null;
let meOverlay = null;
let pinOverlays = [];
const pinEls = new Map();
let mapReq = 0;
let suppressing = false;

const mapCenter = () => state.pos || DEFAULT_POS;

// 코드로 지도를 움직일 때는 "이 지역에서 다시 검색" 버튼을 띄우지 않음
function suppressMove(fn) {
  suppressing = true;
  fn();
  setTimeout(() => (suppressing = false), 400);
}

function onMapMoved() {
  if (suppressing) return;
  state.moved = true;
  renderMapUI();
}

function showMap() {
  if (state.sdk !== "ready") return;
  if (map) {
    map.relayout(); // 숨겨져 있던 지도를 다시 보일 때 크기 재계산
    return;
  }
  map = new kakao.maps.Map($("#map"), { center: toLatLng(mapCenter()), level: 4 });
  kakao.maps.event.addListener(map, "dragend", onMapMoved);
  kakao.maps.event.addListener(map, "zoom_changed", onMapMoved);
  updateMe();
  searchMap();
}

function updateMe() {
  if (!map) return;
  if (meOverlay) meOverlay.setMap(null);
  meOverlay = null;
  if (!state.pos) return;
  const el = document.createElement("div");
  el.className = "kme";
  meOverlay = new kakao.maps.CustomOverlay({ position: toLatLng(state.pos), content: el, zIndex: 1 });
  meOverlay.setMap(map);
}

// fromInput: 검색창에서 Enter → 주변 5km(없으면 전국)에서 찾고 결과에 맞춰 지도 이동
//            그 외 → 지금 보이는 지도 범위 안에서 찾기
function searchMap(fromInput = false) {
  if (!map) return;
  const req = ++mapReq;
  state.mapLoading = true;
  state.mapError = false;
  state.moved = false;
  renderMapUI();

  const { Status } = kakao.maps.services;
  const places = new kakao.maps.services.Places();
  const query = $("#map-search").value.trim();

  const done = (data, status) => {
    if (req !== mapReq) return;
    if (fromInput && status === Status.ZERO_RESULT && !done.nationwide) {
      done.nationwide = true;
      places.keywordSearch(query, done, { category_group_code: FOOD });
      return;
    }
    state.mapLoading = false;
    if (status === Status.OK) state.mapItems = data.map(normalize);
    else {
      state.mapItems = [];
      state.mapError = status !== Status.ZERO_RESULT;
    }
    drawPins();
    if (fromInput && state.mapItems.length) {
      const bounds = new kakao.maps.LatLngBounds();
      state.mapItems.forEach((r) => bounds.extend(toLatLng(r)));
      suppressMove(() => map.setBounds(bounds));
    }
    renderMapUI();
  };

  if (fromInput && query) {
    places.keywordSearch(query, done, { location: map.getCenter(), radius: 5000, category_group_code: FOOD });
  } else if (query) {
    places.keywordSearch(query, done, { bounds: map.getBounds(), category_group_code: FOOD });
  } else {
    places.categorySearch(FOOD, done, { bounds: map.getBounds() });
  }
}

function drawPins() {
  pinOverlays.forEach((o) => o.setMap(null));
  pinOverlays = [];
  pinEls.clear();
  state.mapItems.forEach((r) => {
    const el = document.createElement("button");
    el.className = "kpin" + (r.id === state.selected?.id ? " selected" : "");
    el.setAttribute("aria-label", r.name);
    el.addEventListener("click", () => select(r));
    const overlay = new kakao.maps.CustomOverlay({
      position: toLatLng(r),
      content: el,
      xAnchor: 0.5,
      yAnchor: 1,
      zIndex: 2,
      clickable: true,
    });
    overlay.setMap(map);
    pinOverlays.push(overlay);
    pinEls.set(r.id, el);
  });
}

function renderMapUI() {
  $("#map-loading").hidden = !(state.mapLoading || state.sdk === "loading");
  $("#research").hidden = !state.moved || state.mapLoading;
  $("#locate").hidden = state.sdk !== "ready";

  const sheet = $("#map-sheet");
  const selected = state.mapItems.find((r) => r.id === state.selected?.id);
  const hint = (text) => (sheet.innerHTML = `<span class="hint">${text}</span>`);

  if (state.sdk === "error") hint(SDK_ERRORS[state.sdkError][0]);
  else if (state.sdk === "loading") hint("지도를 불러오고 있어요…");
  else if (state.mapLoading) hint("식당을 찾고 있어요…");
  else if (state.mapError) hint("식당 정보를 불러오지 못했어요");
  else if (selected) sheet.innerHTML = `<div class="thumb" aria-hidden="true">${selected.emoji}</div>${infoHTML(selected)}`;
  else if (!state.mapItems.length) hint("이 지역에 맞는 식당이 없어요");
  else hint(`핀을 눌러 식당 정보를 확인하세요 · 식당 ${state.mapItems.length}곳${state.pos ? "" : " (기본 위치 기준)"}`);
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2000);
}

$("#research").addEventListener("click", () => searchMap());

$("#locate").addEventListener("click", () => {
  if (!map) return;
  suppressMove(() => {
    map.setLevel(4);
    map.setCenter(toLatLng(mapCenter()));
  });
  searchMap();
  toast(state.pos ? "내 위치로 이동했어요" : "위치 권한이 없어 기본 위치로 이동했어요");
});

$("#map-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) searchMap(true);
});
// 검색창의 ✕ 로 지웠을 때
$("#map-search").addEventListener("search", (e) => {
  if (!e.target.value) searchMap();
});

// ───────── 선택 / 렌더 ─────────
function select(place) {
  state.selected = place || null;
  pinEls.forEach((el, id) => el.classList.toggle("selected", id === state.selected?.id));
  renderNearby();
  renderMapUI();
}

function render() {
  renderChips();
  renderNearby();
  renderMapUI();
}

// ───────── 시작 ─────────
async function start() {
  render();
  const sdkReady = loadSdk().then(
    () => (state.sdk = "ready"),
    (err) => {
      state.sdk = "error";
      state.sdkError = err;
    }
  );
  await locate();
  await sdkReady;
  state.loading = false;
  if (state.sdk === "ready" && !$("#view-map").hidden) showMap();
  refreshForPosition();
  render();
}

start();
