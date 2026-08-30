/*
    OPENSTREAM v3 — same three real, free, public APIs as before, now
    behind a redesigned "premium streaming platform" UI:

    1. INTERNET ARCHIVE (archive.org)   — full, legal, public-domain films.
    2. TMDB (themoviedb.org)            — movie metadata + official trailers.
    3. JIKAN (api.jikan.moe)            — anime metadata + official trailers.

    Nothing here streams full copyrighted movies or anime — see the
    top-of-file note in the previous version if you're wondering why:
    there is no free, legal API that does that. TMDB/Jikan give you real
    official trailers (hosted on YouTube by the studios themselves); the
    Internet Archive gives you real full films that are actually
    public domain.
*/


// ============================================================
// CONFIG
// ============================================================

// Get a free key at https://www.themoviedb.org/settings/api
// (Sign up -> Settings -> API -> "Create" under "Request an API Key" ->
// choose "Developer" -> fill in the short form. Approval is instant.)
const TMDB_API_KEY = "PASTE_YOUR_TMDB_API_KEY_HERE";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500";
const TMDB_BACKDROP_BASE = "https://image.tmdb.org/t/p/original";

const JIKAN_BASE = "https://api.jikan.moe/v4";

const ARCHIVE_SEARCH_API = "https://archive.org/advancedsearch.php";
const ARCHIVE_METADATA_API = "https://archive.org/metadata/";

const WATCHLIST_STORAGE_KEY = "openstream_watchlist_v1";


// ============================================================
// STATE
// ============================================================

// "archive" | "tmdb" | "anime" | "watchlist" — drives what performSearch()
// and empty/loading messaging do.
let currentSource = "archive";

// Full normalized item objects currently on screen, keyed by a composite
// "source:id" string, so a card click can look up the full raw record
// without re-fetching it.
const itemCache = new Map();

// The item currently shown in the hero banner / open in the modal —
// tracked so the watchlist buttons in each know what they're toggling.
let currentHeroItem = null;
let currentModalItem = null;


// ============================================================
// JSONP HELPER (Internet Archive only)
// ============================================================

/*
    Archive.org's advancedsearch.php and metadata endpoints don't send
    an Access-Control-Allow-Origin header, so a plain fetch() gets
    blocked by CORS. Archive.org officially documents JSONP (a
    "callback" parameter) as the workaround. TMDB and Jikan both
    support CORS properly, so they use plain fetch() further down.
    See https://archive.org/help/json.php
*/
function jsonp(url) {
    return new Promise((resolve, reject) => {
        const callbackName = "jsonp_cb_" + Math.random().toString(36).slice(2);
        const script = document.createElement("script");

        const timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error("The request timed out."));
        }, 15000);

        function cleanup() {
            clearTimeout(timeoutId);
            delete window[callbackName];
            script.remove();
        }

        window[callbackName] = data => {
            cleanup();
            resolve(data);
        };

        script.onerror = () => {
            cleanup();
            reject(new Error("The API request failed."));
        };

        const separator = url.includes("?") ? "&" : "?";
        script.src = `${url}${separator}callback=${callbackName}`;
        document.body.appendChild(script);
    });
}


// ============================================================
// STARTUP
// ============================================================

window.addEventListener("DOMContentLoaded", () => {
    if (TMDB_API_KEY === "PASTE_YOUR_TMDB_API_KEY_HERE") {
        console.warn(
            "OpenStream: no TMDB API key set yet. The Movies and Comedy " +
            "sections won't load until you add one — see the CONFIG " +
            "comment at the top of script.js."
        );
    }
    setRowTitle("Public Domain Films");
    loadPublicDomainFilms();
});


// ============================================================
// SECTION: INTERNET ARCHIVE (full public-domain films)
// ============================================================

async function loadPublicDomainFilms(searchTerm = "public domain") {
    currentSource = "archive";
    const grid = document.getElementById("movieGrid");
    grid.innerHTML = '<div class="loading">Searching the Internet Archive...</div>';

    try {
        const query = `(${searchTerm}) AND mediatype:movies`;
        const url =
            `${ARCHIVE_SEARCH_API}?q=${encodeURIComponent(query)}` +
            `&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=date&fl[]=description` +
            `&rows=20&output=json`;

        const data = await jsonp(url);
        const docs = data.response.docs;

        setResultCount(docs.length, "public-domain film");

        const items = docs.map(doc => ({
            key: `archive:${doc.identifier}`,
            source: "archive",
            title: doc.title || "Untitled",
            subtitle: `${doc.creator || "Unknown creator"} • ${doc.date || "Unknown date"}`,
            poster: `https://archive.org/services/img/${doc.identifier}`,
            badge: "Full film · Public domain",
            raw: doc,
        }));

        renderGrid(items, "No public-domain films found for that search.");
        renderHeroFromItem(items[0]);
    } catch (error) {
        console.error(error);
        grid.innerHTML = '<div class="loading">Something went wrong while contacting the Internet Archive.</div>';
        clearHero();
    }
}

async function openArchiveItem(item) {
    try {
        const identifier = item.raw.identifier;
        const data = await jsonp(`${ARCHIVE_METADATA_API}${encodeURIComponent(identifier)}`);
        const metadata = data.metadata || {};
        const files = data.files || [];
        const videoFile = findPlayableVideoFile(files);

        if (!videoFile) {
            alert(
                "A playable video file could not be found for this item. " +
                "You can still open the Internet Archive page."
            );
            window.open(`https://archive.org/details/${identifier}`, "_blank");
            return;
        }

        const videoURL =
            `https://archive.org/download/${encodeURIComponent(identifier)}/` +
            `${encodeURIComponent(videoFile.name)}`;

        openModal({
            item,
            title: metadata.title || item.title,
            description: cleanHTML(metadata.description),
            metaHtml: escapeHTML(item.subtitle),
            genres: normalizeSubjects(metadata.subject),
            linkLabel: "View item on Internet Archive",
            linkUrl: `https://archive.org/details/${identifier}`,
            mode: "video",
            videoUrl: videoURL,
        });
    } catch (error) {
        console.error(error);
        alert("There was a problem loading this film.");
    }
}

function normalizeSubjects(subject) {
    if (!subject) return [];
    const raw = Array.isArray(subject) ? subject.join(";") : subject;
    return raw.split(/[;,]/).map(s => s.trim()).filter(Boolean).slice(0, 5);
}

function findPlayableVideoFile(files) {
    const playableExtensions = [".mp4", ".webm", ".ogv", ".ogg"];
    let video = files.find(file => (file.name?.toLowerCase() || "").endsWith(".mp4"));
    if (video) return video;
    video = files.find(file => {
        const name = file.name?.toLowerCase() || "";
        return playableExtensions.some(ext => name.endsWith(ext));
    });
    return video;
}


// ============================================================
// SECTION: TMDB (movie metadata + official trailers)
// ============================================================

async function loadTmdbPopular() {
    currentSource = "tmdb";
    await runTmdbRequest(`${TMDB_BASE}/movie/popular?api_key=${TMDB_API_KEY}&language=en-US&page=1`);
}

// genreId 35 = Comedy in TMDB's genre list.
async function loadTmdbGenre(genreId) {
    currentSource = "tmdb";
    await runTmdbRequest(
        `${TMDB_BASE}/discover/movie?api_key=${TMDB_API_KEY}&with_genres=${genreId}&sort_by=popularity.desc`
    );
}

async function searchTmdb(term) {
    currentSource = "tmdb";
    await runTmdbRequest(`${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(term)}`);
}

async function runTmdbRequest(url) {
    const grid = document.getElementById("movieGrid");
    grid.innerHTML = '<div class="loading">Loading from TMDB...</div>';

    if (TMDB_API_KEY === "PASTE_YOUR_TMDB_API_KEY_HERE") {
        grid.innerHTML = `
            <div class="loading">
                This section needs a free TMDB API key.<br>
                Get one at themoviedb.org/settings/api, then paste it into
                the TMDB_API_KEY constant near the top of script.js.
            </div>`;
        setResultCount(0, "movie");
        clearHero();
        return;
    }

    try {
        const response = await fetch(url);

        if (response.status === 401) {
            grid.innerHTML = '<div class="loading">TMDB rejected the API key. Double-check TMDB_API_KEY in script.js.</div>';
            clearHero();
            return;
        }
        if (!response.ok) throw new Error("TMDB request failed.");

        const data = await response.json();
        const results = data.results || [];

        setResultCount(results.length, "movie");

        const items = results
            .filter(m => m.poster_path)
            .map(m => ({
                key: `tmdb:${m.id}`,
                source: "tmdb",
                title: m.title,
                subtitle: (m.release_date || "").slice(0, 4) || "Release date unknown",
                poster: `${TMDB_IMG_BASE}${m.poster_path}`,
                badge: "Trailer · TMDB",
                raw: m,
            }));

        renderGrid(items, "No movies found for that search.");
        if (items.length) renderHeroFromItem(items[0]);
        else clearHero();
    } catch (error) {
        console.error(error);
        grid.innerHTML = '<div class="loading">Something went wrong while contacting TMDB.</div>';
        clearHero();
    }
}

async function openTmdbItem(item) {
    const movieId = item.raw.id;
    try {
        const [detailsRes, videosRes] = await Promise.all([
            fetch(`${TMDB_BASE}/movie/${movieId}?api_key=${TMDB_API_KEY}&language=en-US`),
            fetch(`${TMDB_BASE}/movie/${movieId}/videos?api_key=${TMDB_API_KEY}&language=en-US`),
        ]);

        if (!detailsRes.ok) throw new Error("Could not load movie details.");

        const details = await detailsRes.json();
        const videos = videosRes.ok ? (await videosRes.json()).results : [];

        const trailer = videos.find(v => v.site === "YouTube" && v.type === "Trailer")
            || videos.find(v => v.site === "YouTube");

        openModal({
            item,
            title: details.title,
            description: details.overview || "No description available.",
            metaHtml: buildTmdbMetaHtml(details),
            genres: (details.genres || []).map(g => g.name),
            linkLabel: "View on TMDB",
            linkUrl: `https://www.themoviedb.org/movie/${movieId}`,
            mode: trailer ? "youtube" : "none",
            youtubeId: trailer ? trailer.key : null,
            noVideoMessage: "No trailer is available for this title on TMDB yet.",
        });
    } catch (error) {
        console.error(error);
        alert("There was a problem loading this movie's details.");
    }
}

function buildTmdbMetaHtml(details) {
    const parts = [];
    const year = (details.release_date || "").slice(0, 4);
    if (year) parts.push(escapeHTML(year));
    const runtime = formatRuntime(details.runtime);
    if (runtime) parts.push(escapeHTML(runtime));
    if (details.vote_average) parts.push(`<span class="rating">★ ${details.vote_average.toFixed(1)}</span>`);
    return parts.join(" &nbsp;·&nbsp; ");
}

function formatRuntime(minutes) {
    if (!minutes) return null;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h ? h + "h " : ""}${m}m`;
}


// ============================================================
// SECTION: JIKAN (anime metadata + official trailers)
// ============================================================

async function loadAnimeTop() {
    currentSource = "anime";
    await runJikanRequest(`${JIKAN_BASE}/top/anime?filter=airing&limit=20`);
}

async function searchAnime(term) {
    currentSource = "anime";
    await runJikanRequest(`${JIKAN_BASE}/anime?q=${encodeURIComponent(term)}&limit=20`);
}

async function runJikanRequest(url) {
    const grid = document.getElementById("movieGrid");
    grid.innerHTML = '<div class="loading">Loading from Jikan (MyAnimeList)...</div>';

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Jikan request failed.");

        const data = await response.json();
        const results = data.data || [];

        setResultCount(results.length, "anime title");

        const items = results
            .filter(a => a.images?.jpg?.image_url)
            .map(a => ({
                key: `anime:${a.mal_id}`,
                source: "anime",
                title: a.title,
                subtitle: `${a.type || "Anime"} • Score: ${a.score ?? "N/A"}`,
                poster: a.images.jpg.image_url,
                badge: "Trailer · MyAnimeList",
                raw: a,
            }));

        renderGrid(items, "No anime found for that search.");
        if (items.length) renderHeroFromItem(items[0]);
        else clearHero();
    } catch (error) {
        console.error(error);
        grid.innerHTML = '<div class="loading">Something went wrong while contacting Jikan.</div>';
        clearHero();
    }
}

function openAnimeItem(item) {
    const anime = item.raw;
    const youtubeId = anime.trailer?.youtube_id || null;

    openModal({
        item,
        title: anime.title,
        description: anime.synopsis || "No synopsis available.",
        metaHtml: buildAnimeMetaHtml(anime),
        genres: (anime.genres || []).map(g => g.name),
        linkLabel: "View on MyAnimeList",
        linkUrl: anime.url,
        mode: youtubeId ? "youtube" : "none",
        youtubeId,
        noVideoMessage: "No trailer is available for this title on MyAnimeList.",
    });
}

function buildAnimeMetaHtml(anime) {
    const parts = [];
    const year = anime.year || (anime.aired?.from ? new Date(anime.aired.from).getFullYear() : null);
    if (year) parts.push(escapeHTML(String(year)));
    if (anime.episodes) parts.push(escapeHTML(`${anime.episodes} eps`));
    else if (anime.type) parts.push(escapeHTML(anime.type));
    if (anime.score) parts.push(`<span class="rating">★ ${anime.score.toFixed(1)}</span>`);
    return parts.join(" &nbsp;·&nbsp; ");
}


// ============================================================
// SHARED: RENDERING GRID CARDS
// ============================================================

function renderGrid(items, emptyMessage) {
    const grid = document.getElementById("movieGrid");
    grid.innerHTML = "";
    itemCache.clear();

    if (items.length === 0) {
        grid.innerHTML = `<div class="loading">${emptyMessage}</div>`;
        return;
    }

    items.forEach(item => {
        itemCache.set(item.key, item);

        const card = document.createElement("div");
        card.className = "movie-card";
        card.innerHTML = `
            <div class="poster-container">
                <img class="poster" src="${item.poster}" alt="${escapeHTML(item.title)}" loading="lazy">
                <div class="play-icon">▶</div>
            </div>
            <div class="movie-info">
                <div class="movie-title">${escapeHTML(item.title)}</div>
                <div class="movie-meta">${escapeHTML(item.subtitle)}</div>
                <div class="movie-badge">${escapeHTML(item.badge)}</div>
            </div>
        `;

        card.addEventListener("click", () => handleCardClick(item));
        grid.appendChild(card);
    });
}

function handleCardClick(item) {
    if (item.source === "archive") {
        openArchiveItem(item);
    } else if (item.source === "tmdb") {
        openTmdbItem(item);
    } else if (item.source === "anime") {
        openAnimeItem(item);
    }
}

function setResultCount(count, noun) {
    document.getElementById("resultCount").textContent = `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function setRowTitle(title) {
    document.getElementById("rowTitle").textContent = title;
}

function scrollRow(direction) {
    document.getElementById("movieGrid").scrollBy({ left: direction * 420, behavior: "smooth" });
}


// ============================================================
// HERO BANNER
// ============================================================

async function renderHeroFromItem(item) {
    if (!item) { clearHero(); return; }

    currentHeroItem = item;

    // Show what we already know immediately; richer detail (description,
    // genres, a wide backdrop image) loads in shortly after.
    document.getElementById("heroBackdrop").style.backgroundImage = `url("${item.poster}")`;
    document.getElementById("heroEyebrow").textContent = item.badge;
    document.getElementById("heroTitle").textContent = item.title;
    document.getElementById("heroMeta").textContent = item.subtitle;
    document.getElementById("heroDescription").textContent = "Loading description...";
    updateHeroWatchlistButton(item);

    let description = "";
    let backdropUrl = item.poster;
    let genreNames = [];

    try {
        if (item.source === "archive") {
            const data = await jsonp(`${ARCHIVE_METADATA_API}${encodeURIComponent(item.raw.identifier)}`);
            description = cleanHTML(data.metadata?.description);
            genreNames = normalizeSubjects(data.metadata?.subject);
        } else if (item.source === "tmdb" && TMDB_API_KEY !== "PASTE_YOUR_TMDB_API_KEY_HERE") {
            const res = await fetch(`${TMDB_BASE}/movie/${item.raw.id}?api_key=${TMDB_API_KEY}&language=en-US`);
            if (res.ok) {
                const details = await res.json();
                description = details.overview || "";
                genreNames = (details.genres || []).map(g => g.name);
                if (details.backdrop_path) backdropUrl = `${TMDB_BACKDROP_BASE}${details.backdrop_path}`;
            }
        } else if (item.source === "anime") {
            description = item.raw.synopsis || "";
            genreNames = (item.raw.genres || []).map(g => g.name);
            if (item.raw.images?.jpg?.large_image_url) backdropUrl = item.raw.images.jpg.large_image_url;
        }
    } catch (error) {
        console.error(error);
    }

    // Bail out quietly if the user has already navigated elsewhere while
    // this was loading.
    if (currentHeroItem !== item) return;

    document.getElementById("heroBackdrop").style.backgroundImage = `url("${backdropUrl}")`;
    document.getElementById("heroDescription").textContent =
        description || "No description available for this title yet.";
    document.getElementById("heroMeta").textContent =
        [item.subtitle, genreNames.slice(0, 3).join(" · ")].filter(Boolean).join("  ·  ");
}

function clearHero() {
    currentHeroItem = null;
    document.getElementById("heroBackdrop").style.backgroundImage = "none";
    document.getElementById("heroEyebrow").textContent = "OpenStream";
    document.getElementById("heroTitle").textContent = "Nothing to show yet";
    document.getElementById("heroMeta").textContent = "";
    document.getElementById("heroDescription").textContent =
        "Try a different section from the menu above, or search for something specific.";
    document.getElementById("heroWatchlistBtn").classList.remove("in-watchlist");
    document.getElementById("heroWatchlistIcon").textContent = "+";
}

function playHeroItem() {
    if (currentHeroItem) handleCardClick(currentHeroItem);
}

function toggleHeroWatchlist() {
    if (!currentHeroItem) return;
    toggleWatchlist(currentHeroItem);
    updateHeroWatchlistButton(currentHeroItem);
}

function updateHeroWatchlistButton(item) {
    const inList = isInWatchlist(item.key);
    document.getElementById("heroWatchlistBtn").classList.toggle("in-watchlist", inList);
    document.getElementById("heroWatchlistIcon").textContent = inList ? "✓" : "+";
}


// ============================================================
// WATCHLIST (stored locally in this browser — see note below)
// ============================================================

/*
    This is a personal, per-browser watchlist stored in localStorage.
    There's no user-accounts system here, so this is intentionally
    device-local rather than something synced to a server.
*/

function getWatchlist() {
    try {
        return JSON.parse(localStorage.getItem(WATCHLIST_STORAGE_KEY)) || [];
    } catch {
        return [];
    }
}

function saveWatchlist(list) {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(list));
}

function isInWatchlist(key) {
    return getWatchlist().some(i => i.key === key);
}

function toggleWatchlist(item) {
    const list = getWatchlist();
    const idx = list.findIndex(i => i.key === item.key);
    if (idx >= 0) {
        list.splice(idx, 1);
    } else {
        list.push(item);
    }
    saveWatchlist(list);
}

function showWatchlist() {
    currentSource = "watchlist";
    setRowTitle("My List");
    const list = getWatchlist();
    setResultCount(list.length, "title");
    renderGrid(list, "Your list is empty — click the + on any title to add it here.");
    renderHeroFromItem(list[0] || null);
}


// ============================================================
// SHARED: DETAIL / PLAYER MODAL
// ============================================================

function openModal({ item, title, description, metaHtml, genres, linkLabel, linkUrl, mode, videoUrl, youtubeId, noVideoMessage }) {
    currentModalItem = item;

    document.getElementById("modalPoster").src = item.poster;
    document.getElementById("modalPoster").alt = title;
    document.getElementById("videoTitle").textContent = title;
    document.getElementById("videoDescription").textContent = description;
    document.getElementById("modalMetaRow").innerHTML = metaHtml || "";

    const genreRow = document.getElementById("modalGenreRow");
    genreRow.innerHTML = (genres || [])
        .map(g => `<span class="genre-pill">${escapeHTML(g)}</span>`)
        .join("");

    updateModalWatchlistButton();

    const link = document.getElementById("archiveLink");
    link.textContent = linkLabel;
    link.href = linkUrl;

    const player = document.getElementById("videoPlayer");
    const frame = document.getElementById("trailerFrame");
    const noVideoNotice = document.getElementById("noVideoNotice");

    // Reset all three before showing the relevant one.
    player.pause();
    player.removeAttribute("src");
    player.load();
    player.style.display = "none";
    frame.src = "";
    frame.style.display = "none";
    noVideoNotice.style.display = "none";

    if (mode === "video") {
        player.style.display = "block";
        player.src = videoUrl;
        player.play().catch(() => {
            // Autoplay can be blocked until the user interacts with the
            // page — the controls are still available either way.
        });
    } else if (mode === "youtube") {
        frame.style.display = "block";
        frame.src = `https://www.youtube.com/embed/${youtubeId}?autoplay=1`;
    } else {
        noVideoNotice.style.display = "block";
        noVideoNotice.textContent = noVideoMessage || "No video is available for this title.";
    }

    document.getElementById("videoModal").classList.add("active");
}

function toggleModalWatchlist() {
    if (!currentModalItem) return;
    toggleWatchlist(currentModalItem);
    updateModalWatchlistButton();
    if (currentHeroItem && currentHeroItem.key === currentModalItem.key) {
        updateHeroWatchlistButton(currentHeroItem);
    }
}

function updateModalWatchlistButton() {
    const inList = currentModalItem ? isInWatchlist(currentModalItem.key) : false;
    document.getElementById("modalWatchlistBtn").classList.toggle("in-watchlist", inList);
    document.getElementById("modalWatchlistIcon").textContent = inList ? "✓" : "+";
    document.getElementById("modalWatchlistLabel").textContent = inList ? "In Your Watchlist" : "Add to Watchlist";
}

function closeVideo() {
    const modal = document.getElementById("videoModal");
    const player = document.getElementById("videoPlayer");
    const frame = document.getElementById("trailerFrame");

    player.pause();
    player.removeAttribute("src");
    player.load();
    frame.src = ""; // stops YouTube playback

    modal.classList.remove("active");
}

document.getElementById("videoModal").addEventListener("click", event => {
    if (event.target.id === "videoModal") {
        closeVideo();
    }
});


// ============================================================
// NAV / SEARCH WIRING
// ============================================================

function showHome() {
    setRowTitle("Public Domain Films");
    loadPublicDomainFilms("public domain");
}

function showDocumentaries() {
    setRowTitle("Documentaries");
    loadPublicDomainFilms("documentary");
}

function showMovies() {
    setRowTitle("Popular Movies");
    loadTmdbPopular();
}

function showComedy() {
    setRowTitle("Comedy Movies");
    loadTmdbGenre(35); // TMDB's genre ID for Comedy
}

function showAnime() {
    setRowTitle("Top Airing Anime");
    loadAnimeTop();
}

function performSearch() {
    const input = document.getElementById("searchInput");
    const term = input.value.trim();
    if (term === "") return;

    setRowTitle(`Results for "${term}"`);

    if (currentSource === "tmdb") {
        searchTmdb(term);
    } else if (currentSource === "anime") {
        searchAnime(term);
    } else if (currentSource === "watchlist") {
        const filtered = getWatchlist().filter(i => i.title.toLowerCase().includes(term.toLowerCase()));
        setResultCount(filtered.length, "title");
        renderGrid(filtered, "Nothing in your list matches that search.");
        renderHeroFromItem(filtered[0] || null);
    } else {
        loadPublicDomainFilms(term);
    }
}

document.getElementById("searchInput").addEventListener("keydown", event => {
    if (event.key === "Enter") {
        performSearch();
    }
});

function setActiveNav(clickedButton) {
    const navKey = clickedButton.dataset.nav;
    document.querySelectorAll(".nav-link").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.nav === navKey);
    });
}

function toggleSearch() {
    const panel = document.getElementById("searchPanel");
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) {
        document.getElementById("searchInput").focus();
    }
}

function toggleMobileNav() {
    document.getElementById("mobileNav").classList.toggle("open");
}


// ============================================================
// UTILITIES
// ============================================================

function cleanHTML(html) {
    if (!html) return "No description available.";
    const el = document.createElement("div");
    el.innerHTML = html;
    return el.textContent.replace(/\s+/g, " ").trim().substring(0, 500);
}

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}