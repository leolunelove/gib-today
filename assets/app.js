
/* Gib .today — a dependency-free, progressively enhanced restaurant directory.
 * Email enquiries use the local backend. Booking providers and phone/chat actions open external services.
 * Personal preferences stay in localStorage; no analytics or remote JavaScript.
 */
(() => {
  'use strict';
  /** @typedef {{id:string,name:string,area:string,cuisine:string,description:string,address:string,phone:string|null,phoneHref:string|null,email:string|null,website:string|null,reservationUrl:string|null,reservationNote:string,tripadvisor:string,contactSource:string,contactSourceName:string,additionalSource?:string,additionalSourceName?:string,image:string|null,imageType:string,reservationPolicy:string,shortDescription:string,coverTone?:string,coverLines?:string[],collections:string[],tags:string[],contactProvenance:string}} Venue */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const external = 'target="_blank" rel="noopener noreferrer"';
  const storage = {
    get(key, fallback) { try { return localStorage.getItem(`table.v1.${key}`) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(`table.v1.${key}`, value); return true; } catch { return false; } }
  };
  let data;
  try { data = window.GIB_TODAY_DATA; } catch (error) { console.error('Unable to load the restaurant directory.', error); return; }
  /** @type {Venue[]} */
  const venues = data.venues;
  const byId = new Map(venues.map(venue => [venue.id, venue]));
  let savedIds;
  try { const parsed = JSON.parse(storage.get('saved', '[]')); savedIds = Array.isArray(parsed) ? parsed.filter(id => byId.has(id)) : []; } catch { savedIds = []; }
  const state = { view: 'explore', query: '', area: 'all', cuisine: 'all', collection: 'all', meal: 'all', sort: 'directory', online: false, openNow: false, delivery: 'all', layout: storage.get('layout', 'grid') === 'list' ? 'list' : 'grid', saved: new Set(savedIds) };
  const hours = window.GibHours;
  const publishedSchedules = hours ? venues.filter(venue => venue.openingHours) : [];
  const holidays = new Set(data.openingHolidays || []);
  const availabilityToggle = $('[data-action="open-now"]');
  let availability = new Map();
  let availabilityTimer;
  const grid = $('#restaurant-grid');
  const placeDialog = $('#place-dialog');
  const infoDialog = $('#info-dialog');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const checkedDate = new Intl.DateTimeFormat('en-GB', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(`${data.checkedAt}T12:00:00Z`));
  let currentVenue = null;
  const dialogMotion = new WeakMap();
  const dialogFocus = new WeakMap();
  const motion = { quick: 130, move: 230, enter: 190, exit: 140, ease: 'cubic-bezier(.22,1,.36,1)' };
  const runningMotion = new Set();
  let toastTimeout;
  let searchTimeout;
  let priorDialogFocus = null;
  const normalise = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').toLocaleLowerCase('en-GB');
  const searchable = new Map(venues.map(venue=>[venue.id,normalise([venue.name,venue.area,venue.cuisine,venue.description,...(venue.delivery || []).map(link=>(data.deliveryProviders || []).find(provider=>provider.id===link.provider)?.name || link.provider),...venue.tags].join(' '))]));

  function notify(message) {
    clearTimeout(toastTimeout);
    const modalToast = placeDialog.open ? $('.dialog-toast', placeDialog) : null;
    $('#toast').classList.remove('visible');
    if (modalToast) {
      $('.dialog-toast-message', modalToast).textContent = message;
      modalToast.classList.add('visible');
    } else {
      $('#toast-message').textContent = message;
      $('#toast').classList.add('visible');
    }
    toastTimeout = setTimeout(() => { $('#toast').classList.remove('visible'); if (modalToast) modalToast.classList.remove('visible'); }, 2800);
  }
  function playMotion(element, frames, options = {}) {
    if (reducedMotion.matches || !element?.animate) return null;
    const animation = element.animate(frames, {duration: motion.move, easing: motion.ease, ...options});
    runningMotion.add(animation);
    animation.finished.catch(() => {}).finally(() => runningMotion.delete(animation));
    return animation;
  }
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) runningMotion.forEach(animation => animation.finish());
  });
  const cardCache = new Map($$('.restaurant-card',grid).map(card => [card.dataset.venue, card]));
  const cardMotion = new WeakMap();
  function animateUpdate(update) {
    if (reducedMotion.matches) { update(); return; }
    const previous = new Map();
    const cards = $$('.restaurant-card', grid);
    // Capture live positions first so rapid changes continue from the current frame.
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < innerHeight) previous.set(card, rect);
    }
    for (const card of cards) cardMotion.get(card)?.cancel();
    update();
    const visible = $$('.restaurant-card',grid).map(card => [card, card.getBoundingClientRect()])
      .filter(([,rect]) => rect.bottom > 0 && rect.top < innerHeight);
    for (const [card, rect] of visible) {
      const before = previous.get(card);
      if (!before) {
        cardMotion.set(card, playMotion(card, [{opacity:.65}, {opacity:1}], {duration:motion.quick}));
        continue;
      }
      const x = Math.round(before.left - rect.left);
      const y = Math.round(before.top - rect.top);
      const distance = Math.hypot(x,y);
      if (distance < 2 || distance > innerHeight * .5) continue;
      cardMotion.set(card, playMotion(card, [{transform:`translate(${x}px, ${y}px)`}, {transform:'none'}]));
    }
  }
  function renderCards(matches) {
    const focused = document.activeElement;
    const focusedCard = focused?.closest('.restaurant-card');
    const oldIndex = focusedCard ? [...grid.children].indexOf(focusedCard) : -1;
    const wanted = new Set(matches.map(venue => venue.id));
    [...grid.children].forEach(child => { if (!wanted.has(child.dataset.venue)) child.remove(); });
    if (!matches.length) { grid.innerHTML = emptyState(); }
    else matches.forEach((venue, index) => {
      let node = cardCache.get(venue.id);
      if (!node) {
        const template = document.createElement('template');
        template.innerHTML = card(venue,index);
        node = template.content.firstElementChild;
        cardCache.set(venue.id,node);
      }
      syncCardHours(node, venue.id);
      const current = grid.children[index];
      if (current !== node) grid.insertBefore(node,current || null);
    });
    if (focusedCard && !document.contains(focused)) {
      const next = grid.children[Math.min(oldIndex,grid.children.length-1)];
      (next?.querySelector('button') || $('#results-heading')).focus({preventScroll:true});
    } else if (focusedCard && document.contains(focused) && document.activeElement !== focused) {
      focused.focus({preventScroll:true});
    }
  }
  function syncCardHours(node, id) {
    const label = $('.card-hours', node);
    const status = availability.get(id) || '';
    if (!label || label.dataset.status === status) return;
    label.dataset.status = status;
    label.hidden = !status;
    label.textContent = status === 'open' ? 'Open now' : status === 'closed' ? 'Closed now' : '';
  }
  function refreshAvailability() {
    if (!publishedSchedules.length) return;
    clearTimeout(availabilityTimer);
    const time = hours.localTime(new Date());
    const next = new Map(publishedSchedules.map(venue => [venue.id, hours.status(venue.openingHours, time, holidays)]));
    const openSetChanged = publishedSchedules.some(({id}) => (next.get(id) === 'open') !== (availability.get(id) === 'open'));
    availability = next;
    if (state.openNow && openSetChanged) render();
    else for (const [id, node] of cardCache) syncCardHours(node, id);
    if (!document.hidden) availabilityTimer = setTimeout(refreshAvailability, 60000 - Date.now() % 60000 + 25);
  }
  let filterMotion;
  const disclosureMotion = new WeakMap();
  function prepareDisclosures(root) {
    $$('details',root).forEach(details => {
      if (details.classList.contains('disclosure')) return;
      const summary = $('summary',details);
      if (!summary) return;
      const content = document.createElement('div');
      content.className = 'disclosure-content';
      [...details.childNodes].forEach(node => { if (node !== summary) content.append(node); });
      details.append(content);
      details.classList.add('disclosure');
      summary.addEventListener('click',event => {
        event.preventDefault();
        const previous = disclosureMotion.get(details);
        const opening = previous ? !previous.opening : !details.open;
        const start = details.getBoundingClientRect().height;
        previous?.animation?.cancel();
        content.inert = !opening;
        details.open = true;
        details.classList.toggle('is-expanded',opening);
        const end = opening ? details.getBoundingClientRect().height : summary.getBoundingClientRect().height +
          parseFloat(getComputedStyle(details).paddingTop) + parseFloat(getComputedStyle(details).paddingBottom) +
          parseFloat(getComputedStyle(details).borderTopWidth) + parseFloat(getComputedStyle(details).borderBottomWidth);
        details.classList.add('is-animating');
        const animation = playMotion(details,[{height:start+'px'},{height:end+'px'}],{duration:opening?motion.move:motion.exit});
        const finish = () => { details.open=opening; details.classList.remove('is-animating'); disclosureMotion.delete(details); };
        disclosureMotion.set(details,{animation,opening});
        if (animation) animation.onfinish=finish; else finish();
      });
    });
  }
  function toggleFilters(force) {
    const panel = $('#filter-panel'), toggle = $('#filters-toggle');
    const opening = force ?? toggle.getAttribute('aria-expanded') !== 'true';
    const start = panel.hidden ? 0 : panel.getBoundingClientRect().height;
    const current = getComputedStyle(panel);
    const startFrame = panel.hidden ? null : {height:start+'px',opacity:current.opacity,paddingTop:current.paddingTop,paddingBottom:current.paddingBottom,marginBottom:current.marginBottom,borderTopWidth:current.borderTopWidth,borderBottomWidth:current.borderBottomWidth};
    filterMotion?.cancel();
    panel.hidden = false;
    panel.inert = !opening;
    toggle.setAttribute('aria-expanded',String(opening));
    if (!opening && panel.contains(document.activeElement)) toggle.focus({preventScroll:true});
    const fullHeight = panel.getBoundingClientRect().height;
    const styles = getComputedStyle(panel);
    const expanded = {height:fullHeight+'px',opacity:1,paddingTop:styles.paddingTop,paddingBottom:styles.paddingBottom,marginBottom:styles.marginBottom,borderTopWidth:styles.borderTopWidth,borderBottomWidth:styles.borderBottomWidth};
    const collapsed = {height:'0px',opacity:0,paddingTop:'0px',paddingBottom:'0px',marginBottom:'0px',borderTopWidth:'0px',borderBottomWidth:'0px'};
    panel.classList.add('is-animating');
    filterMotion = playMotion(panel,[startFrame || collapsed,opening?expanded:collapsed],{duration:opening?motion.move:motion.exit});
    const finish = () => { panel.hidden=!opening; panel.classList.remove('is-animating'); filterMotion=null; };
    if (filterMotion) filterMotion.onfinish=finish; else finish();
  }
  function getFiltered() {
    const terms = normalise(state.query.trim()).split(/\s+/).filter(Boolean);
    const result = venues.filter(venue => {
      const haystack = searchable.get(venue.id);
      return (state.view !== 'saved' || state.saved.has(venue.id)) && (state.area === 'all' || venue.area === state.area) && (state.cuisine === 'all' || venue.cuisine === state.cuisine) && (state.collection === 'all' || (venue.collections || []).includes(state.collection)) && (state.meal === 'all' || (venue.meals || []).includes(state.meal)) && (!state.online || Boolean(venue.reservationUrl)) && (!state.openNow || availability.get(venue.id) === 'open') && (state.delivery === 'all' || (venue.delivery || []).some(l=>state.delivery === 'any' || l.provider === state.delivery)) && terms.every(term => haystack.includes(term));
    });
    if (state.sort === 'az') result.sort((a,b) => a.name.localeCompare(b.name, 'en'));
    if (state.sort === 'za') result.sort((a,b) => b.name.localeCompare(a.name, 'en'));
    return result;
  }
  function coverHTML(venue, index = 0, detail = false) {
    const e = escapeHTML;
    if (venue.image) {
      return `<img class="venue-photo" src="${e(venue.image)}" srcset="${e(venue.imageSrcSet || '')}" sizes="${detail ? '(max-width: 700px) 100vw, (max-width: 1150px) 46vw, 520px' : '(max-width: 624px) 100vw, (max-width: 880px) 48vw, (max-width: 1200px) 40vw, 26vw'}" alt="${e(venue.imageAlt || venue.name)}" width="${venue.imageWidth || 960}" height="${venue.imageHeight || 640}" style="object-position:${e(venue.imagePosition || '50% 50%')}" loading="${detail || index < 3 ? 'eager' : 'lazy'}" decoding="async"${detail || index === 0 ? ' fetchpriority="high"' : ''}>${venue.imageNotice ? `<span class="image-notice">${e(venue.imageNotice)}</span>` : ''}`;
    }
    const number = String(venues.findIndex(item=>item.id===venue.id)+1).padStart(2,'0');
    return `<div class="editorial-cover" data-tone="${e(venue.coverTone || 'stone')}" aria-hidden="true"><span class="cover-kicker"><span>${e(venue.cuisine)}</span><span class="cover-number">Nº ${number}</span></span><span class="cover-title">${(venue.coverLines || [venue.name]).map(line=>`<span>${e(line)}</span>`).join('')}</span><svg class="cover-landscape" viewBox="0 0 400 180" fill="none"><path d="M0 145h400M0 159h400M0 173h400" stroke="currentColor"/><path d="M130 145l36-23 23-35 27-17 13-24 29-6 16 27 12 8 20 37 38 33Z" fill="currentColor"/><path d="M229 46l-13 24-27 17-23 35-36 23m128-105-8 35-21 26-6 44" stroke="var(--cover-bg)" stroke-width="2"/></svg><span class="cover-footer"><span>${e(venue.area)}</span><span>Explore ↗</span></span></div>`;
  }
  function contactLabel(venue) {
    if (venue.onlineOrdering) return 'Order direct';
    if (venue.tradingStatus === 'unconfirmed') return 'Check trading status';
    if (venue.reservationPolicy === 'walk-in') return 'Walk in';
    if (venue.reservationUrl) return 'Online booking';
    if (venue.phone) return venue.bookingMethod === 'call-reserve' ? 'Call to reserve' : 'Call venue';
    if (venue.email) return 'Email an enquiry';
    return 'Ask the venue';
  }
  function card(venue, index) {
    const e = escapeHTML, saved = state.saved.has(venue.id);
    const route = `/place/${encodeURIComponent(venue.id)}/`;
    const contactText = contactLabel(venue);
    const deliveryNames = (venue.delivery || []).map(link =>
      (data.deliveryProviders || []).find(provider => provider.id === link.provider)?.name || link.provider);
    const showContact = !deliveryNames.length || venue.onlineOrdering || venue.reservationUrl || venue.reservationPolicy === 'walk-in';
    return `<article class="restaurant-card" data-venue="${e(venue.id)}" style="--i:${index}">
      <div class="card-photo-wrap"><a class="card-photo" href="${route}" data-action="open-place" data-id="${e(venue.id)}" aria-label="View place at ${e(venue.name)}" tabindex="-1">${coverHTML(venue,index)}</a>
        <button class="save-button" data-action="save" data-id="${e(venue.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Unsave' : 'Save'} ${e(venue.name)}" title="${saved ? 'Remove from saved places' : 'Save place'}">${icon('bookmark')}</button></div>
      <div class="card-content">
        <p class="card-subtitle"><span>${e(venue.area)}</span><span class="sep" aria-hidden="true"></span><span>${e(venue.cuisine)}</span></p>
        <h3 class="card-title"><a href="${route}" data-action="open-place" data-id="${e(venue.id)}"><span>${e(venue.name)}</span></a></h3>
        <p class="card-description">${e(venue.shortDescription || venue.description)}</p>
        <div class="card-bottom">
          ${venue.openingHours ? '<span class="card-hours" data-status="" title="Based on published venue hours in Gibraltar" hidden></span>' : ''}
          ${showContact ? `<span class="contact-type">${e(contactText)}</span>` : ''}
          ${deliveryNames.length ? `<p class="card-delivery" aria-label="Listed on ${e(deliveryNames.join(', '))}">${e(deliveryNames.join(' · '))}</p>` : ''}
        </div>
      </div></article>`;
  }
  function emptyState() {
    const entirelyEmptySaved = state.view === 'saved' && state.saved.size === 0;
    return `<div class="empty-state"><div class="empty-icon">${icon(entirelyEmptySaved ? 'bookmark' : 'search')}</div><h3>${entirelyEmptySaved ? 'No saved places yet' : 'No matching places'}</h3><p>${entirelyEmptySaved ? 'Bookmark a restaurant to keep it here for later.' : state.openNow ? 'No places with verified hours are open under these filters.' : 'Try a different search or clear the filters.'}</p><button class="button secondary" data-action="${entirelyEmptySaved ? 'home' : 'reset-filters'}">${entirelyEmptySaved ? 'Explore the directory' : 'Clear all filters'} ${icon('arrow')}</button></div>`;
  }
  function syncSaved() {
    $$('[data-saved-count]').forEach(el => { if(el.textContent !== String(state.saved.size)) el.textContent = state.saved.size; });
    $$('[data-action="save"]').forEach(button => {
      const venue = byId.get(button.dataset.id);
      if (!venue) return;
      const saved = state.saved.has(venue.id);
      if(button.getAttribute('aria-pressed') === String(saved) && button.getAttribute('aria-label') === `${saved ? 'Unsave' : 'Save'} ${venue.name}`) return;
      button.setAttribute('aria-pressed', String(saved));
      button.setAttribute('aria-label', `${saved ? 'Unsave' : 'Save'} ${venue.name}`);
      button.title = saved ? 'Remove from saved places' : 'Save place';
    });
  }
  function syncControls() {
    $('.sidebar [data-view="explore"] .count').textContent = venues.length;
    $$('.sidebar [data-action="area"]').forEach(button => { $('.count', button).textContent = button.dataset.area === 'all' ? venues.length : venues.filter(venue => venue.area === button.dataset.area).length; });
    $$('[data-action="view"]').forEach(button => {
      const selected = button.dataset.view === state.view;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
    });
    $$('[data-action="area"]').forEach(button => { const selected = button.dataset.area === state.area; button.classList.toggle('active',selected); if(selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
    $$('[data-action="collection"]').forEach(button => { const active = button.dataset.collection === state.collection; button.setAttribute('aria-pressed',String(active)); button.classList.toggle('active',active); });
    $('#cuisine-select').value = state.cuisine;
    $$('[data-action="layout"]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.layout === state.layout)));
    $('#area-select').value = state.area;
    $('#sort-select').value = state.sort;
    $('#online-only').checked = state.online;
    availabilityToggle.setAttribute('aria-pressed',String(state.openNow));
    $('#availability-note').hidden = !state.openNow;
    $('#meal-note').hidden = state.meal === 'all';
    $$('[data-action="meal"]').forEach(button => { const active = button.dataset.meal === state.meal; button.setAttribute('aria-pressed',String(active)); button.classList.toggle('active',active); });
    $('#delivery-select').value = state.delivery;
    $('#clear-search').hidden = !state.query;
    $('#search-hint').hidden = Boolean(state.query);
    $('#filter-dot').hidden = state.area === 'all' && state.cuisine === 'all' && state.collection === 'all' && !state.online && state.delivery === 'all' && state.sort === 'directory';
    $('#breadcrumb-page').textContent = state.view === 'saved' ? 'Saved places' : 'Explore';
    const pageTitle = $('#page-title');
    if (pageTitle.dataset.view !== `${state.view}:${state.area}`) {
      pageTitle.dataset.view = `${state.view}:${state.area}`;
      pageTitle.innerHTML = state.view === 'saved' ? 'Your <span class="marker-word">saved places</span>' : state.area !== 'all' ? `<span class="marker-word">${escapeHTML(state.area)}</span>` : 'Where to <span class="marker-word">eat</span>';
    }
    syncSaved();
  }
  function render() {
    const focusedToken = document.activeElement?.closest('.active-token');
    const tokenIndex = focusedToken ? [...$('#active-filters').children].indexOf(focusedToken) : -1;
    const matches = getFiltered();
    const hasSearch = Boolean(state.query.trim());
    grid.classList.toggle('list-mode',state.layout === 'list');
    renderCards(matches);
    const total = $('#result-total');
    if (total.textContent !== String(matches.length)) total.textContent = matches.length;
    $('#results-heading').textContent = state.area !== 'all' ? 'Places' : state.collection !== 'all' ? data.collections.find(c=>c.id===state.collection)?.name || 'Collection' : hasSearch || state.cuisine !== 'all' || state.online || state.openNow || state.delivery !== 'all' ? 'Matching places' : state.meal !== 'all' ? `${state.meal[0].toUpperCase()+state.meal.slice(1)} places` : state.view === 'saved' ? 'Bookmarks' : 'All places';
    $('#results-status').textContent = `${matches.length} restaurant${matches.length === 1 ? '' : 's'}${state.openNow ? ' open now' : ''}${state.meal !== 'all' ? ` for ${state.meal}` : ''} ${state.view === 'saved' ? 'in your saved places' : 'in the directory'}${hasSearch ? ` matching “${state.query.trim()}”` : ''}.`;
    const tokens = [];
    if (state.cuisine !== 'all') tokens.push(`<button class="active-token" data-action="clear-cuisine" aria-label="Remove cuisine filter">${escapeHTML(state.cuisine)} ${icon('close')}</button>`);
    if (state.area !== 'all') tokens.push(`<button class="active-token" data-action="clear-area" aria-label="Remove neighbourhood filter">${escapeHTML(state.area)} ${icon('close')}</button>`);
    if (state.collection !== 'all') tokens.push(`<button class="active-token" data-action="clear-collection" aria-label="Remove collection filter">${escapeHTML(data.collections.find(c=>c.id===state.collection)?.name || 'Collection')} ${icon('close')}</button>`);
    if (state.online) tokens.push(`<button class="active-token" data-action="clear-online" aria-label="Remove online reservation filter">Online reservation page ${icon('close')}</button>`);
    if (state.delivery !== 'all') tokens.push(`<button class="active-token" data-action="clear-delivery" aria-label="Remove delivery app filter">${escapeHTML(state.delivery==='any'?'Delivery apps':data.deliveryProviders.find(p=>p.id===state.delivery)?.name || 'Delivery')} ${icon('close')}</button>`);
    $('#active-filters').innerHTML = tokens.join('');
    $('#active-filters').hidden = !tokens.length;
    if (focusedToken) ($('#active-filters').children[Math.min(tokenIndex,tokens.length-1)] || $('#filters-toggle')).focus({preventScroll:true});
    syncControls();
    scheduleScrollHints();
  }
  function resetFilters() {
    clearTimeout(searchTimeout);
    state.query = ''; state.area = 'all'; state.cuisine = 'all'; state.collection = 'all'; state.meal = 'all'; state.online = false; state.openNow = false; state.delivery = 'all'; state.sort = 'directory';
    $('#search-input').value = '';
    if(/^\/area\//.test(location.pathname)) history.pushState(null,'','/');
    updateMetadata(null,null);
    render();
  }
  function setView(view) {
    state.view = view === 'saved' ? 'saved' : 'explore';
    resetFilters();
    if(/^\/area\//.test(location.pathname)) history.pushState(null,'','/');
    updateMetadata(null,null);
    // A navigation change starts at the top on every screen size.
    // Avoid a long animated trip through the previous results.
    window.scrollTo({top:0,behavior:'instant'});
  }
  function toggleSaved(id) {
    const venue = byId.get(id); if (!venue) return;
    if (state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
    const persisted = storage.set('saved', JSON.stringify([...state.saved]));
    if (state.view === 'saved') animateUpdate(render); else syncSaved();
    notify(persisted ? (state.saved.has(id) ? `${venue.name} — saved for later.` : `${venue.name} — removed.`) : 'Saved for this visit. Browser storage is unavailable.');
  }
  function safeHistoryHash(hash) {
    try { history.replaceState(null,'',`${location.pathname}${location.search}${hash}`); } catch { /* file previews may restrict History API; the directory still works. */ }
  }
  function googleMapsLink(venue) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${venue.name}, ${venue.address}`)}`;
  }
  function localDateValue() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  }
  function sourceAnchor(url, text) { return `<a href="${escapeHTML(url)}" ${external}>${escapeHTML(text)} ${icon('external')}</a>`; }
  function venueDialogHTML(venue) {
    const e = escapeHTML;
    const walkIn = venue.reservationPolicy === 'walk-in';
    const delivery = venue.delivery || [];
    const provider = id => (data.deliveryProviders || []).find(item => item.id === id)?.name || id;
    const hasDirectOrder = Boolean(venue.onlineOrdering);
    const hasOrderLinks = hasDirectOrder || delivery.length || venue.alternateMenus?.length;
    const action = (url, title, detail, primary = false, ico = 'external') => `
      <a class="place-action ${primary ? 'place-action-primary' : ''}" href="${e(url)}" ${external}>
        <span><strong>${e(title)}</strong>${detail ? `<small>${e(detail)}</small>` : ''}</span>${icon(ico)}
      </a>`;
    const onlineButton = venue.reservationUrl
      ? action(venue.reservationUrl, venue.bookingLabel || 'Book a table', 'Official booking link', !hasDirectOrder, 'table')
      : '';
    const phoneButton = venue.phone && !walkIn ? `
      <a class="place-action ${!venue.reservationUrl && !hasDirectOrder ? 'place-action-primary' : ''}" href="tel:${e(venue.phoneHref)}">
        <span><strong>${venue.bookingMethod === 'call-reserve' ? 'Call to book' : 'Call restaurant'}</strong><small>${e(venue.phone)}</small></span>${icon('phone')}
      </a>` : '';
    const emailButton = venue.email && !walkIn && venue.emailBookingAllowed !== false ? `
      <a class="place-action" data-email-link href="mailto:${e(venue.email)}?subject=${encodeURIComponent('Dining enquiry — '+venue.name)}">
        <span><strong>Email an enquiry</strong>${data.contactSendingEnabled === false ? '<small>Online enquiries temporarily unavailable</small>' : ''}</span>${icon('mail')}
      </a>` : '';
    const deliveryLinks = delivery.map(link => `
      <a class="delivery-option" href="${e(link.url)}" ${external}>
        <span><strong>${e(provider(link.provider))}</strong>${link.availabilityNote ? `<small>${e(link.availabilityNote)}</small>` : ''}</span>${icon('external')}
      </a>`).join('');
    const sources = [
      ...(venue.verification || []),
      ...(hasDirectOrder ? [{source:venue.onlineOrdering.source,checkedAt:venue.onlineOrdering.checkedAt,note:'Official direct ordering link.'}] : []),
      ...delivery.map(link => ({source:link.source,checkedAt:link.checkedAt,note:provider(link.provider)+' restaurant listing.'}))
    ];
    const menuInOrdering = venue.menuUrl === venue.onlineOrdering?.url || delivery.some(link => link.url === venue.menuUrl);
    const siteLinks = [
      venue.website ? sourceAnchor(venue.website,'Website') : '',
      venue.tripadvisor ? sourceAnchor(venue.tripadvisor,'Tripadvisor reviews') : '',
      ...['instagram','facebook'].filter(key => venue[key]).map(key => sourceAnchor(venue[key],key === 'instagram' ? 'Instagram' : 'Facebook'))
    ].join('');
    const visit = `
      <section class="place-section reserve-block" aria-labelledby="reserve-title">
        <h3 id="reserve-title">${walkIn ? 'Walk in' : venue.visitType === 'visit-collection' ? 'Visit & collection' : 'Eat here'}</h3>
        ${walkIn ? '<p class="walkin-note">Walk-ins only, according to the official listing.</p>' : `
          <div class="contact-buttons">${onlineButton}${phoneButton}${venue.whatsapp ? action(venue.whatsapp, 'Message on WhatsApp', '', false, 'message') : ''}${emailButton}</div>`}
        ${venue.reservationNote ? `<details class="booking-notes"><summary>Booking notes</summary><p class="reservation-note">${e(venue.reservationNote)}</p></details>` : ''}
        ${!walkIn && venue.emailBookingAllowed === false && venue.email ? `
          <div class="detail-links">${sourceAnchor('mailto:'+venue.email, 'General enquiries by email')}</div>` : ''}
      </section>`;
    const ordering = hasOrderLinks ? `
      <section class="place-section order-section" aria-labelledby="order-title">
        <h3 id="order-title">Order &amp; delivery</h3>
        ${hasDirectOrder ? `<div class="direct-order">${action(venue.onlineOrdering.url, venue.onlineOrdering.label, venue.onlineOrdering.provider, true, 'arrow')}</div>` : ''}
        ${delivery.length ? `
          <div class="delivery-options">${deliveryLinks}</div>
          <p class="place-fineprint">Availability varies by app.</p>` : ''}
        ${venue.alternateMenus?.length ? `
          <details class="price-detail"><summary>More menus at this address</summary>
            <div class="detail-links">${venue.alternateMenus.map(link => sourceAnchor(link.url, link.name+' · '+provider(link.provider))).join('')}</div>
          </details>` : ''}
      </section>` : '';
    const nearby = venues.filter(other => other.id !== venue.id && other.area === venue.area).slice(0,2);
    return `
      <div class="dialog-top-actions">
        <a class="place-back" href="/" data-action="close-place" autofocus>${icon('arrow')}<span>Back to places</span></a>
        <span class="dialog-current-name" aria-hidden="true">${e(venue.name)}</span>
        <button class="icon-button" data-action="share-place" aria-label="Copy link to ${e(venue.name)}" title="Copy place link">${icon('link')}</button>
        <button class="icon-button" data-action="save" data-id="${e(venue.id)}" aria-pressed="${state.saved.has(venue.id)}" aria-label="Save ${e(venue.name)}">${icon('bookmark')}</button>
      </div>
      <div class="dialog-scroll"><div class="dialog-content">
        <header class="place-hero">
          <div class="dialog-photo">${coverHTML(venue,0,true)}</div>
          <div class="place-heading">
            <p class="dialog-kicker"><a href="/area/${slugForArea(venue.area)}/" data-action="area" data-area="${e(venue.area)}">${e(venue.area)}</a> · ${e(venue.cuisineDetail || venue.cuisine)}</p>
            <h1 id="place-title"><span class="marker-word">${e(venue.name)}</span></h1>
            <p class="dialog-description">${e(venue.description)}</p>
            <nav class="place-quick-links" aria-label="Restaurant links">
              ${venue.menuUrl && !menuInOrdering ? sourceAnchor(venue.menuUrl,'Menu') : ''}
              ${sourceAnchor(googleMapsLink(venue),'Get directions')}
            </nav>
          </div>
        </header>
        <div class="place-layout">
          ${hasDirectOrder ? ordering : visit}
          <aside class="place-rail" aria-label="Plan your visit">
            <section class="visit-panel">
              <h3>Plan your visit</h3>
              <div class="visit-fact"><span class="place-eyebrow">Address</span><address>${e(venue.address)}</address></div>
              <div class="visit-fact"><span class="place-eyebrow">Opening hours</span><p>${e(venue.hours || 'Hours not verified. Check with the restaurant before visiting.')}</p></div>
              <details class="price-detail"><summary>Menu &amp; price notes</summary><p>${e(venue.priceNote || 'See the current menu for prices.')}</p></details>
            </section>
          </aside>
          ${hasDirectOrder ? visit : ordering}
        </div>
        ${nearby.length ? `<section class="detail-section nearby-section"><h3>More in ${e(venue.area)}</h3>
          ${nearby.map(other => `<a class="similar-place" href="/place/${e(other.id)}/" data-action="open-place" data-id="${e(other.id)}"><span>${e(other.name)}<small> · ${e(other.cuisine)}</small></span>${icon('arrow')}</a>`).join('')}
        </section>` : ''}
        <footer class="place-footer">
          ${siteLinks ? `<nav class="place-quick-links" aria-label="Restaurant websites">${siteLinks}</nav>` : ''}
          <details class="source-details">
            <summary>Sources &amp; listing checks</summary>
            <p>Restaurant details checked ${e(venue.checkedAt || data.checkedAt)}. Delivery listings checked ${e(venue.deliveryCheckedAt || data.deliveryCheckedAt)}. ${delivery.length ? 'Confirm availability with the delivery app.' : 'No delivery app listing verified.'}</p>
            ${(venue.auditIssues || []).length ? `<ul>${venue.auditIssues.map(issue => `<li>${e(issue)}</li>`).join('')}</ul>` : ''}
            ${sources.map(check => `<p>${check.linkStatus === 'unrelated-redirect' ? e('Former website withheld: '+check.source) : sourceAnchor(check.source,'Source · '+check.checkedAt)}${check.note ? `<small>${e(check.note)}</small>` : ''}</p>`).join('')}
            ${venue.image ? `<p>${sourceAnchor(venue.imageSource,venue.imageCredit)}<small>${e(venue.imageRightsStatus || '')}</small></p>` : ''}
            <p class="source-footnote">Restaurants and delivery providers handle orders and table bookings.</p>
          </details>
          <div class="trust-links">
            <a href="mailto:${e(data.contactEmail)}?subject=${encodeURIComponent('Correction: '+venue.name)}">Report incorrect information</a>
            <a href="mailto:${e(data.contactEmail)}?subject=${encodeURIComponent('Owner update: '+venue.name)}">Restaurant owner? Update this listing</a>
          </div>
        </footer>
      </div></div>
      <button class="scroll-cue detail-scroll-cue" type="button" data-action="scroll-more" data-scroll="details" aria-label="Scroll to more restaurant details" hidden>Keep scrolling ${icon('chevron')}</button>
      <div class="dialog-toast" role="status" aria-live="polite">${icon('check')}<span class="dialog-toast-message"></span></div>`;
  }
  function showPlace(id, changeHash = true) {
    const venue = byId.get(id); if (!venue) return;
    if (infoDialog.open) infoDialog.close();
    const prerendered=placeDialog.dataset.prerendered===id;
    const replacing = placeDialog.open && !prerendered;
    const resuming = replacing && placeDialog.classList.contains('closing');
    const sameVenue = currentVenue?.id === id;
    const from = resuming ? dialogFrame(placeDialog) : null;
    if(prerendered) { placeDialog.dataset.initial='true'; placeDialog.close(); delete placeDialog.dataset.prerendered; }
    else delete placeDialog.dataset.initial;
    if (!replacing || resuming) cancelDialogClose(placeDialog);
    if (!replacing) { priorDialogFocus = document.activeElement; dialogFocus.set(placeDialog,priorDialogFocus); }
    currentVenue = venue;
    if (!prerendered && !sameVenue) placeDialog.innerHTML = venueDialogHTML(venue);
    prepareDisclosures(placeDialog);
    if (!placeDialog.open) openModal(placeDialog, prerendered);
    else if (resuming) animateDialog(placeDialog, from, true);
    delete document.documentElement.dataset.initialPlace;
    syncScrollLock();
    if (!sameVenue) {
      placeDialog.classList.remove('is-scrolled');
      const scroller = $('.dialog-scroll',placeDialog);
      scroller.scrollTop = 0;
      scroller.addEventListener('scroll',scheduleScrollHints,{passive:true});
      observeDetailScroll();
    }
    $('[data-action="close-place"]',placeDialog).focus({preventScroll:true});
    if (replacing && !sameVenue && !resuming) {
      playMotion($('.dialog-content',placeDialog),[{opacity:.55},{opacity:1}],{duration:motion.quick});
    }
    if (changeHash) history[replacing?'replaceState':'pushState']({tablePlace:true},'',`/place/${encodeURIComponent(id)}/`);
    updateMetadata(venue);
    updateMessage();
    syncSaved();
  }
  function syncScrollLock() {
    document.documentElement.style.overflow = document.querySelector('dialog[open]') ? 'hidden' : '';
    scheduleScrollHints();
  }
  function dialogFrame(dialog) {
    const style = getComputedStyle(dialog);
    return {opacity:style.opacity, transform:style.transform};
  }
  function cancelDialogClose(dialog) {
    dialogMotion.get(dialog)?.cancel();
    dialogMotion.delete(dialog);
    dialog.classList.remove('closing');
  }
  const dialogRest = {opacity:1,transform:'none'};
  const dialogEdge = {opacity:.55,transform:'translateY(.4rem)'};
  function animateDialog(dialog, from, opening) {
    cancelDialogClose(dialog);
    dialog.classList.toggle('closing',!opening);
    const animation = playMotion(dialog,[from,opening ? dialogRest : dialogEdge],{
      duration:opening ? motion.enter : motion.exit,
      easing:opening ? motion.ease : 'cubic-bezier(.4,0,1,1)',
      fill:'both'
    });
    const finish = () => {
      dialogMotion.delete(dialog);
      if (!opening) dialog.close();
      animation?.cancel();
      dialog.classList.remove('closing');
    };
    if (animation) {
      dialogMotion.set(dialog,animation);
      animation.onfinish = finish;
    } else finish();
  }
  function openModal(dialog, immediate=false) {
    dialog.showModal();
    if (!immediate) animateDialog(dialog,dialogEdge,true);
  }
  function closeDialog(dialog) {
    if (!dialog.open || dialog.classList.contains('closing')) return;
    if (dialog === placeDialog && !routeClosing) {
      if (history.state?.tablePlace) { history.back(); return; }
      history.replaceState(null,'','/'); updateMetadata(null);
    }
    animateDialog(dialog,dialogFrame(dialog),false);
  }
  function onDialogClosed(dialog) {
    // A queued native close event must not clear a newly reopened dialog.
    if (dialog.open) return;
    cancelDialogClose(dialog);
    if (dialog === placeDialog) { currentVenue = null; if(!grid.children.length) render(); updateMetadata(null); }
    syncScrollLock();
    const focus = dialogFocus.get(dialog);
    const topDialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (focus?.isConnected && focus !== document.body && (!topDialog || topDialog.contains(focus))) focus.focus({preventScroll:true});
    else if (!topDialog) $('#search-input').focus({preventScroll:true});
  }
  function infoHTML(page) {
    const sources = page === 'sources';
    const sourceEntries = (sources ? venues : []).map(venue => `<details><summary>${escapeHTML(venue.name)}</summary>${sourceAnchor(venue.contactSource,venue.contactSourceName)}${venue.tripadvisor?sourceAnchor(venue.tripadvisor,'Tripadvisor review listing'):''}<small>${escapeHTML(venue.contactProvenance)}</small></details>`).join('');
    return `<div class="info-toolbar"><span class="popup-current-name" aria-hidden="true">${sources ? 'About & sources' : 'Guide'}</span><button class="icon-button close-info" data-action="close-info" aria-label="Close guide" autofocus>${icon('close')}</button></div><div class="info-content"><h2 id="info-title">${sources ? 'About the <span class="marker-word">directory</span>' : 'Find a <span class="marker-word">place to eat</span>'}</h2>${sources ? `<p class="info-intro">An independent starting point for eating out in Gibraltar. ${venues.length} selected places across ${data.areas.length} neighbourhoods. Not a complete list, and not a paid ranking.</p><h3>What makes it into the directory?</h3><p>A Gibraltar location and current restaurant or delivery-menu evidence, with a published way to contact, order from or visit the business. The selection covers a spread of cuisines, neighbourhoods and meal types. Inclusion is not a quality rating, first-hand review or partnership.</p><h3>Published details, not live availability.</h3><p>Original package check: ${checkedDate}. Individual listings show their latest check date. Some entries still await a fresh full check. Opening hours and availability are not inferred. Tripadvisor scores and review counts stay on Tripadvisor, where you can read the current listing.</p><div class="source-list">${sourceEntries}</div><h3>A note on the photography</h3><p>The directory uses venue images from business websites, delivery menus, official tourism pages and credited venue galleries. Promotional artwork is labelled. Sources are linked on each listing. Some source images are promotional graphics or archival photographs. They do not establish current trading status. Image sources are credited; original photographer and reuse permissions have not been independently confirmed. Editorial covers remain as a fallback if an image cannot load. No generated images are presented as restaurant photographs.</p><h3>Your browser. Your saved places.</h3><p>Saved places, layout and appearance are stored only in this browser. There are no accounts, tracking scripts, booking records or advertising cookies. Clearing browser data removes your saved places. Contact messages are delivered through an email service to the recipient shown. Limited delivery and abuse-prevention records are kept; message bodies are not stored by this directory. External websites have their own privacy practices.</p><button class="button secondary" data-action="theme">${icon('moon')}<span data-theme-label>Switch to dark appearance</span></button>` : `<p class="info-intro">Find a restaurant by name, neighbourhood, cuisine or meal.</p><dl class="guide-list"><dt>Open now</dt><dd>Uses checked opening hours. Confirm kitchen hours with the restaurant.</dd><dt>Menus, bookings and delivery</dt><dd>Open a place to see the restaurant’s links and delivery options.</dd><dt>Saved places</dt><dd>Use the bookmark icon to save places in this browser.</dd></dl><button class="text-button" data-action="info" data-page="sources">About &amp; sources</button>`}</div>`;
  }
  function showInfo(page) {
    cancelDialogClose(infoDialog);
    if (placeDialog.open) placeDialog.close();
    const replacing = infoDialog.open;
    if (!infoDialog.open) dialogFocus.set(infoDialog,document.activeElement);
    infoDialog.innerHTML = infoHTML(page);
    syncTheme();
    prepareDisclosures(infoDialog);
    if (!infoDialog.open) openModal(infoDialog);
    infoDialog.scrollTop = 0;
    infoDialog.classList.remove('is-scrolled');
    if (replacing) playMotion($('.info-content',infoDialog),[{opacity:.25,transform:'translateY(8px)'},{opacity:1,transform:'none'}]);
    $('.close-info', infoDialog).focus({preventScroll:true});
    syncScrollLock();
  }
  function updateMessage() {
    if (!currentVenue || !$('#message-preview')) return;
    const guests = $('#message-guests').value;
    const dateValue = $('#message-date').value;
    const time = $('#message-time').value;
    let dateText = 'a date to be agreed';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      const date = new Date(`${dateValue}T12:00:00`);
      if (!Number.isNaN(date.getTime())) dateText = new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(date);
    }
    const message = `Hello ${currentVenue.name}, do you have a table for ${guests} ${guests === '1' ? 'person' : 'people'} on ${dateText}${time ? ` at ${time}` : ''}? Please let me know whether you can confirm this. Thank you.`;
    $('#message-preview').value = message;
    const email = $('[data-email-link]');
    if (email && currentVenue.email) email.href = `mailto:${currentVenue.email}?subject=${encodeURIComponent(`Table enquiry — ${currentVenue.name}`)}&body=${encodeURIComponent(message)}`;
  }
  async function copyText(text, successMessage) {
    try { if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(text); notify(successMessage); return; } catch { /* Local file / insecure origin fallback. */ }
    const input = document.createElement('textarea');
    input.value = text; input.setAttribute('aria-label','Text to copy');
    input.style.cssText = 'position:fixed;top:0;left:0;width:.0625rem;height:.0625rem;opacity:0';
    const focus = document.activeElement;
    (placeDialog.open ? placeDialog : infoDialog.open ? infoDialog : document.body).append(input);
    input.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    input.remove();
    if (focus && document.contains(focus)) focus.focus({preventScroll:true});
    notify(copied ? successMessage : 'Copy unavailable. Select and copy the visible text.');
    if (!copied && $('#message-preview') && text === $('#message-preview').value) { $('#message-preview').focus(); $('#message-preview').select(); }
  }
  let themeTimer;
  let requestedTheme = document.documentElement.dataset.theme || 'light';
  function applyTheme(theme, button) {
    if (theme === requestedTheme) return;
    requestedTheme = theme;
    const root = document.documentElement;
    clearTimeout(themeTimer);
    root.classList.remove('theme-wave');
    if (!reducedMotion.matches) {
      root.classList.add('theme-switching');
      if (button && !document.querySelector('dialog[open]')) {
        const bounds = button.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        const reach = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
        root.style.setProperty('--theme-wave-origin', `${x}px ${y}px`);
        root.style.setProperty('--theme-wave-reach', `${reach + 120}px`);
        // Reset the visual wave when switching again. The live page stays interactive.
        void root.offsetWidth;
        root.classList.add('theme-wave');
      }
      themeTimer = setTimeout(() => root.classList.remove('theme-switching','theme-wave'), 430);
    } else root.classList.remove('theme-switching');
    root.dataset.theme = theme;
    syncTheme();
  }
  function setTheme(button) {
    const theme = requestedTheme === 'dark' ? 'light' : 'dark';
    applyTheme(theme,button);
    storage.set('theme',theme);
  }
  function syncTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    $('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const label = `Switch to ${dark ? 'light' : 'dark'} appearance`;
    $$('[data-action="theme"]').forEach(button => {
      $('use',button)?.setAttribute('href',dark ? '#i-sun' : '#i-moon');
      const visibleLabel = $('[data-theme-label]',button);
      if (visibleLabel) visibleLabel.textContent = label;
      button.setAttribute('aria-label',label);
      button.title = label;
    });
  }
  let routeClosing = false;
  function slugForArea(area) { return normalise(area).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
  function pageMetadata(venue = null, area = null) {
    const origin = 'https://gib.today';
    const count = area ? venues.filter(item=>item.area===area).length : venues.length;
    const route = venue ? `/place/${venue.id}/` : area ? `/area/${slugForArea(area)}/` : '/';
    const title = venue
      ? `${venue.name} in Gibraltar · ${venue.reservationUrl ? 'Menu & booking' : (venue.delivery || []).length ? 'Menu & delivery' : 'Menu & contact'} | Gib .today`
      : area ? `${area} restaurants, Gibraltar | Gib .today` : 'Restaurants in Gibraltar · Menus & delivery | Gib .today';
    const full = venue ? `${venue.name} in ${venue.area}, Gibraltar. ${venue.shortDescription || venue.description}` : area
      ? `Find ${count} restaurants and cafés in ${area}, Gibraltar. Compare menus, booking links, published opening hours and local delivery options.`
      : `Explore ${count} restaurants and cafés in Gibraltar. Find menus, booking links, verified opening hours and delivery on HungryMonkey, RockHero and NomNom’s.`;
    const description = full.length > 160 ? full.slice(0,157).replace(/\s+\S*$/,'')+'…' : full;
    const image = `${origin}/assets/social/${venue ? venue.id : area ? 'area-'+slugForArea(area) : 'home'}-20261121.jpg`;
    const photo = (venue?.image ? venue : null) || venues.find(item => (!area || item.area === area) && item.image && !item.imageNotice);
    const alt = venue ? `${venue.name} in ${venue.area}, Gibraltar. ${venue.imageAlt || venue.cuisine}` : area ? `Places to eat in ${area}, Gibraltar` : 'Gib .today — restaurants, menus and delivery in Gibraltar';
    const primaryPhoto = photo ? new URL(photo.image,origin).href : image;
    const photoDetails = photo && {width:photo.imageWidth,height:photo.imageHeight,caption:photo.imageAlt,credit:photo.imageCredit,source:photo.imageSource};
    return {title,description,url:origin+route,image,alt,primaryPhoto,photoDetails};
  }
  function structuredData(venue = null, area = null) {
    const origin='https://gib.today', meta=pageMetadata(venue,area);
    const {photoDetails, primaryPhoto}=meta;
    const photoId=primaryPhoto+'#image';
    const graph=[
      {'@type':'Organization','@id':origin+'/#publisher',name:'Gib .today',url:origin+'/',logo:{'@type':'ImageObject',url:origin+'/assets/icon-512.png',width:512,height:512}},
      {'@type':'WebSite','@id':origin+'/#website',url:origin+'/',name:'Gib .today',alternateName:'gib.today',inLanguage:'en-GB',publisher:{'@id':origin+'/#publisher'}},
      {
        '@type':'ImageObject','@id':photoId,contentUrl:primaryPhoto,url:primaryPhoto,
        width:photoDetails?.width || 1200,height:photoDetails?.height || 630,
        caption:photoDetails?.caption || meta.alt,
        ...(photoDetails?.credit ? {creditText:photoDetails.credit} : {}),
        ...(photoDetails?.source ? {citation:photoDetails.source} : {})
      },
      {'@type':venue?'WebPage':'CollectionPage','@id':meta.url+'#webpage',url:meta.url,name:meta.title,description:meta.description,inLanguage:'en-GB',isPartOf:{'@id':origin+'/#website'},publisher:{'@id':origin+'/#publisher'},primaryImageOfPage:{'@id':photoId},thumbnailUrl:primaryPhoto,...(venue||area?{breadcrumb:{'@id':meta.url+'#breadcrumb'}}:{}),mainEntity:{'@id':meta.url+(venue?'#restaurant':'#places')}}
    ];
    const crumbs=[{name:'Restaurants in Gibraltar',item:origin+'/'}];
    const neighbourhood=venue?.area || area;
    if(neighbourhood) crumbs.push({name:neighbourhood,item:origin+'/area/'+slugForArea(neighbourhood)+'/'});
    if(venue) crumbs.push({name:venue.name,item:meta.url});
    if(crumbs.length>1) graph.push({'@type':'BreadcrumbList','@id':meta.url+'#breadcrumb',itemListElement:crumbs.map((item,index)=>({'@type':'ListItem',position:index+1,...item}))});
    if(venue) {
      const street=venue.address.replace(/,?\s*Gibraltar\s*(?:GX11\s*1AA)?\s*$/i,'').trim();
      const entity={'@type':'Restaurant','@id':meta.url+'#restaurant',name:venue.name,url:venue.website || meta.url,mainEntityOfPage:{'@id':meta.url+'#webpage'},description:venue.description,image:{'@id':photoId},address:{'@type':'PostalAddress',streetAddress:street,addressLocality:'Gibraltar',addressCountry:'GI',...(/GX11\s*1AA/i.test(venue.address)?{postalCode:'GX11 1AA'}:{})},servesCuisine:venue.cuisine,sameAs:['website','tripadvisor','instagram','facebook'].map(key=>venue[key]).filter(Boolean)};
      if(venue.phoneHref) entity.telephone=venue.phoneHref;
      if(venue.email) entity.email=venue.email;
      if(venue.menuUrl) { entity.hasMenu=venue.menuUrl; entity.menu=venue.menuUrl; }
      // Null days are unknown. Only reviewed intervals and explicitly closed days are emitted.
      if(venue.openingHours) {
        const days=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
        const clock=minutes=>`${String(Math.floor((minutes%1440)/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
        const specifications=[];
        venue.openingHours.week.forEach((ranges,index)=>{
          if(ranges===null) return;
          if(!ranges.length) specifications.push({'@type':'OpeningHoursSpecification',dayOfWeek:'https://schema.org/'+days[index],opens:'00:00',closes:'00:00'});
          else ranges.forEach(([start,end])=>specifications.push({'@type':'OpeningHoursSpecification',dayOfWeek:'https://schema.org/'+days[index],opens:clock(start),closes:start===0&&end===1440?'23:59':clock(end)}));
        });
        if(specifications.length) entity.openingHoursSpecification=specifications;
      }
      graph.push(entity);
    } else {
      const matches=area?venues.filter(item=>item.area===area):venues;
      graph.push({'@type':'ItemList','@id':meta.url+'#places',name:area?`Restaurants in ${area}, Gibraltar`:'Restaurants in Gibraltar',numberOfItems:matches.length,itemListElement:matches.map((item,index)=>({'@type':'ListItem',position:index+1,name:item.name,url:origin+`/place/${item.id}/`}))});
    }
    return {'@context':'https://schema.org','@graph':graph};
  }
  function updateMetadata(venue, area = state.area === 'all' ? null : state.area) {
    const meta=pageMetadata(venue,venue?null:area);
    document.title=meta.title;
    $('meta[name="description"]').content=meta.description;
    for(const [key,value] of Object.entries({'og:title':meta.title,'og:description':meta.description,'og:url':meta.url,'og:image':meta.image,'og:image:secure_url':meta.image,'og:image:alt':meta.alt})) {
      const tag=$(`meta[property="${key}"]`); if(tag) tag.content=value;
    }
    for(const [key,value] of Object.entries({'twitter:title':meta.title,'twitter:description':meta.description,'twitter:image':meta.image,'twitter:image:alt':meta.alt})) {
      const tag=$(`meta[name="${key}"]`); if(tag) tag.content=value;
    }
    $('link[rel="canonical"]').href=meta.url;
    const image=$('link[rel="image_src"]'); if(image) image.href=meta.primaryPhoto;
    const schema=$('#page-schema'); if(schema) schema.textContent=JSON.stringify(structuredData(venue,venue?null:area));
  }
  function navigateArea(area, push=true) {
    state.view='explore'; state.area=area;
    if(placeDialog.open) placeDialog.close();
    currentVenue=null;
    const url=area==='all'?'/':`/area/${slugForArea(area)}/`;
    if(push && location.pathname!==url) history.pushState(null,'',url);
    animateUpdate(render); updateMetadata(null);
    window.scrollTo({top:0,behavior:'instant'});
  }
  function handleHash() {
    const match = location.pathname.match(/^\/place\/([a-z0-9-]+)\/?$/) || location.hash.match(/^#place\/([a-z0-9-]+)$/);
    if (contactDialog.open) contactDialog.close();
    if (match && byId.has(match[1])) showPlace(match[1],false);
    else {
      const areaMatch=location.pathname.match(/^\/area\/([a-z0-9-]+)\/?$/);
      const area=areaMatch ? data.areas.find(item=>slugForArea(item)===areaMatch[1]) : null;
      if(placeDialog.open) { routeClosing=true; closeDialog(placeDialog); routeClosing=false; }
      state.area=area || 'all'; render(); updateMetadata(null);
    }
  }
  const contactDialog = document.createElement('dialog');
  contactDialog.className = 'contact-dialog';
  contactDialog.setAttribute('aria-labelledby', 'contact-title');
  document.body.append(contactDialog);
  let contactTarget = null, contactTrigger = null, contactRequestId = null, contactPayload = null;
  [infoDialog,contactDialog].forEach(dialog=>{
    let frame=0;
    dialog.addEventListener('scroll',()=>{
      if(frame) return;
      frame=requestAnimationFrame(()=>{dialog.classList.toggle('is-scrolled',dialog.scrollTop>64);frame=0;});
    },{passive:true});
  });
  function showContact(link) {
    const close = $('.contact-close',contactDialog);
    const toolbar = document.createElement('div');
    toolbar.className = 'contact-toolbar';
    const title = document.createElement('span');
    title.className = 'popup-current-name'; title.setAttribute('aria-hidden','true');
    title.textContent = $('#contact-title').textContent;
    toolbar.append(title,close); contactDialog.prepend(toolbar);
    close.onclick=()=>closeDialog(contactDialog);
    const back = $('.contact-back',contactDialog);
    if(back) back.onclick=()=>closeDialog(contactDialog);
    dialogFocus.set(contactDialog,link);
    cancelDialogClose(contactDialog);
    openModal(contactDialog);
    contactDialog.scrollTop=0;
    contactDialog.classList.remove('is-scrolled');
    close.focus({preventScroll:true});
    syncScrollLock();
  }
  function openContact(link) {
    contactTarget = new URL(link.href); contactTrigger = link; contactRequestId = (crypto.randomUUID?.() || 'forms-disabled'); contactPayload = null;
    const email = contactTarget.protocol === 'mailto:';
    const phone = contactTarget.protocol === 'tel:';
    const subject = contactTarget.searchParams.get('subject') || (currentVenue ? 'Enquiry — '+currentVenue.name : 'Get in touch');
    const editorialEmail = email && decodeURIComponent(contactTarget.pathname).toLowerCase() === data.contactEmail.toLowerCase();
    const emailTitle = editorialEmail ? (/correction/i.test(subject) ? 'Report a correction' : /suggest/i.test(subject) ? 'Suggest a place' : /owner|listing update/i.test(subject) ? 'Update a listing' : 'Get in touch.') : 'Email the restaurant';
    if (phone) {
      contactDialog.innerHTML = `<form class="contact-form contact-phone"><button type="button" class="icon-button contact-close" aria-label="Close contact form" autofocus>${icon('close')}</button><p class="dialog-kicker">${escapeHTML(currentVenue?.name || 'Restaurant contact')}</p><h2 id="contact-title">Call the restaurant</h2><p class="contact-phone-number">${escapeHTML(currentVenue?.phone || decodeURIComponent(contactTarget.pathname))}</p><p>Your phone app will open with the restaurant’s number. The restaurant can confirm tables and today’s hours.</p><button class="button primary" type="submit">Continue to call ${icon('phone')}</button></form>`;
      showContact(link);
      return;
    }
    if (email && data.contactSendingEnabled === false) {
      const restaurantEmail = decodeURIComponent(contactTarget.pathname).toLowerCase() !== data.contactEmail.toLowerCase();
      const title = /correction/i.test(subject) ? 'Report a correction' : /suggest/i.test(subject) ? 'Suggest a place' : /owner|listing update/i.test(subject) ? 'Update a listing' : 'Get in touch.';
      contactDialog.innerHTML = `<div class="contact-form"><button type="button" class="icon-button contact-close" aria-label="Close contact form" autofocus>${icon('close')}</button><p class="dialog-kicker">${/correction/i.test(subject) ? 'Corrections' : /suggest/i.test(subject) ? 'Suggestions' : /owner|listing update/i.test(subject) ? 'Listing updates' : 'Contact'}</p><h2 id="contact-title">${title}</h2><div class="contact-unavailable"><strong>Messages are taking a breather.</strong><p>Online enquiries are temporarily unavailable.${restaurantEmail ? ' You can still use this restaurant’s phone, WhatsApp or official booking link where listed.' : ' Please check back to send a suggestion or update.'}</p></div><button class="button secondary contact-back" type="button">${currentVenue ? 'Back to the restaurant' : 'Back to exploring'} ${icon('arrow')}</button></div>`;
      showContact(link);
      return;
    }
    contactDialog.innerHTML = `<form class="contact-form"><button type="button" class="icon-button contact-close" aria-label="Close contact form">${icon('close')}</button><p class="dialog-kicker">${email ? 'Email enquiry' : phone ? 'Phone enquiry' : 'WhatsApp enquiry'}</p><h2 id="contact-title">${escapeHTML(email ? emailTitle : subject)}</h2><p>${email ? 'Send your message here. Replies go to the email address you provide.' : phone ? 'Add a note for your call, then open your phone app.' : 'Prepare your message, then send it in WhatsApp.'}</p><label>Your name${email ? '' : ' (optional)'}<input name="name" autocomplete="name" ${email ? 'required' : ''} maxlength="100" placeholder="Name"></label>${email ? '<label>Your email<input name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"></label><div class="contact-honeypot" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>' : ''}<label>Message<textarea name="message" rows="5" maxlength="5000" required placeholder="Your message…"></textarea></label><p class="contact-destination">To: ${escapeHTML(editorialEmail ? 'Site editor' : email || phone ? decodeURIComponent(contactTarget.pathname) : currentVenue?.name || 'Restaurant')}</p><button class="button primary" type="submit">${phone ? 'Continue to call' : email ? 'Send message' : 'Open WhatsApp to send'} ${icon('arrow')}</button><p class="source-footnote">${email ? 'Your name, email and message are sent to the recipient shown above.' + (editorialEmail ? '' : ' Table enquiries need restaurant confirmation.') : 'You complete the action in the next app.'}</p><p class="contact-status" role="status" aria-live="polite"></p></form>`;
    contactDialog.querySelector('textarea').value = contactTarget.searchParams.get('body') || '';
    showContact(link);
  }
  function showContactSuccess(form, payload, kind, venue) {
    const screen = document.createElement('section');
    screen.className = 'contact-success';
    const thanks = {suggestion:'Thanks for sharing a place worth knowing.', correction:'Thanks for helping keep the details right.', owner:'Thanks for sending your listing update.', general:'Thanks for getting in touch.'};
    screen.innerHTML = `<div class="contact-success-stamp" aria-hidden="true">${icon('check')}</div><h2 id="contact-title" tabindex="-1"><span class="marker-word">Message sent</span></h2><p class="contact-success-copy">${kind === 'restaurant' ? `Your enquiry is on its way to ${escapeHTML(venue.name)}${/[.!?]$/.test(venue.name) ? '' : '.'}` : thanks[kind]}</p><div class="contact-reply-note">${icon('mail')}<p>Replies go to<strong>${escapeHTML(payload.email)}</strong></p></div>${kind === 'restaurant' ? '<p class="contact-success-note">The restaurant will need to reply to confirm any booking.</p>' : ''}<button type="button" class="button primary contact-done">${placeDialog.open ? 'Back to the restaurant' : 'Back to exploring'} ${icon('arrow')}</button>`;
    form.replaceWith(screen);
    $('.popup-current-name',contactDialog).textContent = 'Message sent';
    contactDialog.scrollTop = 0;
    contactDialog.classList.remove('is-scrolled');
    $('.contact-done',screen).onclick = () => closeDialog(contactDialog);
    if (contactDialog.open && !contactDialog.classList.contains('closing')) {
      playMotion(screen,[{opacity:.4},{opacity:1}],{duration:motion.enter});
      $('#contact-title',screen).focus({preventScroll:true});
    }
  }
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || contactDialog.contains(link)) return;
    if (/^(mailto:|tel:|https:\/\/wa\.me\/)/i.test(link.href)) { event.preventDefault(); openContact(link); }
  }, true);
  contactDialog.addEventListener('click', event => { if (event.target === contactDialog) { const b=contactDialog.getBoundingClientRect(); if(event.clientX<b.left || event.clientX>b.right || event.clientY<b.top || event.clientY>b.bottom) closeDialog(contactDialog); } });
  contactDialog.addEventListener('close', () => onDialogClosed(contactDialog));
  contactDialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog(contactDialog);});
  contactDialog.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    if (contactTarget.protocol === 'mailto:') {
      if (data.contactSendingEnabled === false) return;
      const button = form.querySelector('[type="submit"]'), status = form.querySelector('.contact-status');
      if (button.disabled) return;
      const subject = contactTarget.searchParams.get('subject') || '';
      const recipient = decodeURIComponent(contactTarget.pathname).toLowerCase();
      const venue = venues.find(v => v.email?.toLowerCase() === recipient);
      const kind = recipient !== data.contactEmail.toLowerCase() ? 'restaurant' : /correction/i.test(subject) ? 'correction' : /owner|listing update/i.test(subject) ? 'owner' : /suggest/i.test(subject) ? 'suggestion' : 'general';
      const payload = {name:form.elements.name.value.trim(), email:form.elements.email.value.trim(), message:form.elements.message.value.trim(), website:form.elements.website.value, kind, venueId:kind === 'restaurant' ? venue?.id : placeDialog.open ? currentVenue?.id : null};
      const serialized = JSON.stringify(payload);
      if (contactPayload !== null && contactPayload !== serialized) contactRequestId = (crypto.randomUUID?.() || 'forms-disabled');
      contactPayload = serialized;
      const requestId = contactRequestId;
      const fields = [...form.querySelectorAll('input,textarea')];
      fields.forEach(field => { field.disabled=true; });
      button.disabled = true; button.innerHTML = 'Sending…';
      status.textContent = 'Sending your message…'; status.className = 'contact-status';
      const controller = new AbortController();
      const timeout = setTimeout(()=>controller.abort(),30000);
      try {
        const response = await fetch(data.contactEndpoint || '/api/contact', {method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,requestId}),signal:controller.signal});
        const result = await response.json();
        if (!response.ok || !result.accepted) throw new Error(result.error || 'Your message could not be sent. Please retry.');
        if (contactRequestId === requestId && contactDialog.contains(form)) showContactSuccess(form, payload, kind, venue);
      } catch (error) {
        fields.forEach(field => { field.disabled=false; });
        status.textContent = error.name === 'AbortError' ? 'The connection timed out. Your message is kept here; retrying will not send a duplicate.' : error instanceof SyntaxError || error instanceof TypeError ? 'Could not connect. Your message is kept here; please retry.' : error.message;
        status.classList.add('contact-error');
        button.disabled=false; button.innerHTML=`Retry sending ${icon('arrow')}`;
      } finally { clearTimeout(timeout); }
      return;
    }
    const url = new URL(contactTarget.href);
    if (url.hostname === 'wa.me') url.searchParams.set('text',[form.elements.message.value.trim(),form.elements.name.value.trim()].filter(Boolean).join('\n\n'));
    const action = document.createElement('a'); action.href=url.href;
    if(url.protocol === 'https:') { action.target='_blank'; action.rel='noopener noreferrer'; }
    contactDialog.append(action); action.click(); action.remove();
  });
  document.addEventListener('error', event => {
    const img=event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('venue-photo')) return;
    const venue=byId.get(img.closest('[data-venue]')?.dataset.venue) || currentVenue;
    if (venue) img.outerHTML=coverHTML({...venue,image:null});
  },true);
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const action = button.dataset.action;
    switch (action) {
      case 'home': animateUpdate(()=>setView('explore')); break;
      case 'view': animateUpdate(()=>setView(button.dataset.view)); break;
      case 'area':
        if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button>0) break;
        event.preventDefault(); navigateArea(button.dataset.area); break;
      case 'collection': animateUpdate(()=>{ state.collection = state.collection === button.dataset.collection ? 'all' : button.dataset.collection; render(); }); break;
      case 'clear-collection': state.collection='all'; animateUpdate(render); break;
      case 'layout':
        if (state.layout === button.dataset.layout) break;
        animateUpdate(()=>{ state.layout = button.dataset.layout; storage.set('layout',state.layout); render(); });
        break;
      case 'save': toggleSaved(button.dataset.id); break;
      case 'open-place':
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) break;
        event.preventDefault(); showPlace(button.dataset.id); break;
      case 'close-place': event.preventDefault(); closeDialog(placeDialog); break;
      case 'close-info': closeDialog(infoDialog); break;
      case 'info': showInfo(button.dataset.page); break;
      case 'theme': setTheme(button); break;
      case 'focus-search': $('#search-input').focus(); break;
      case 'clear-search': clearTimeout(searchTimeout); state.query = ''; $('#search-input').value=''; animateUpdate(render); $('#search-input').focus(); break;
      case 'reset-filters': animateUpdate(resetFilters); break;
      case 'clear-cuisine': state.cuisine='all'; animateUpdate(render); break;
      case 'clear-area': navigateArea('all'); break;
      case 'meal': state.meal=button.dataset.meal; animateUpdate(render); break;
      case 'scroll-more': {
        const target = button.dataset.scroll === 'areas' ? $('.areas') : $('.dialog-scroll',placeDialog);
        if (!target) break;
        target.scrollBy({top:target.clientHeight*.65,behavior:reducedMotion.matches?'instant':'smooth'});
        // Hints may disappear at the end; keep keyboard focus on the scrolled region.
        target.setAttribute('tabindex','-1'); target.focus({preventScroll:true});
        break;
      }
      case 'clear-delivery': state.delivery='all'; animateUpdate(render); break;
      case 'clear-online': state.online=false; animateUpdate(render); break;
      case 'open-now':
        refreshAvailability();
        state.openNow = !state.openNow;
        animateUpdate(render);
        break;
      case 'toggle-filters': toggleFilters(); break;
      case 'copy-phone': if (currentVenue) copyText(currentVenue.phone,'Phone number copied'); break;
      case 'copy-message': if ($('#message-preview')) copyText($('#message-preview').value,'Enquiry copied. Nothing has been sent.'); break;
      case 'share-place': if (currentVenue) {
        if (location.protocol === 'file:') { copyText(currentVenue.tripadvisor || currentVenue.contactSource,'Restaurant link copied'); }
        else copyText(new URL(`/place/${currentVenue.id}/`,location.href).href,'Place link copied');
      } break;
    }
  });
  $('#search-input').addEventListener('input',event => { state.query = event.target.value; clearTimeout(searchTimeout); searchTimeout = setTimeout(()=>animateUpdate(render),65); });
  $('#area-select').addEventListener('change',event => navigateArea(event.target.value));
  $('#cuisine-select').addEventListener('change',event => { state.cuisine=event.target.value; animateUpdate(render); });
  $('#online-only').addEventListener('change',event => { state.online=event.target.checked; animateUpdate(render); });
  $('#delivery-select').addEventListener('change',event => { state.delivery=event.target.value; animateUpdate(render); });
  $('#sort-select').addEventListener('change',event=>{ state.sort=event.target.value; animateUpdate(render); });
  placeDialog.addEventListener('input',event => { if (event.target.matches('#message-guests,#message-date,#message-time')) updateMessage(); });
  placeDialog.addEventListener('change',event => { if (event.target.matches('#message-guests,#message-date,#message-time')) updateMessage(); });
  [placeDialog,infoDialog].forEach(dialog => {
    dialog.addEventListener('cancel',event => { event.preventDefault(); closeDialog(dialog); });
    dialog.addEventListener('click',event => { if (event.target !== dialog) return; const box=dialog.getBoundingClientRect(); if(event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeDialog(dialog); });
    dialog.addEventListener('close',()=>onDialogClosed(dialog));
  });
  document.addEventListener('keydown',event => {
    const typing = event.target.matches('input,textarea,select,[contenteditable]');
    if (((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k') || (event.key==='/'&&!typing)) {
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault(); $('#search-input').focus();
    }
    if (event.key==='Escape' && document.activeElement===$('#search-input') && !placeDialog.open && !infoDialog.open) { state.query=''; $('#search-input').value=''; render(); $('#search-input').blur(); }
  });
  // Keep saved bookmarks consistent across open tabs, without a server or login.
  window.addEventListener('storage',event => {
    if (event.key === 'table.v1.theme') applyTheme(event.newValue === 'dark' ? 'dark' : 'light');
    if (event.key!=='table.v1.saved') return;
    try { const parsed=JSON.parse(event.newValue||'[]'); state.saved=new Set(Array.isArray(parsed)?parsed.filter(id=>byId.has(id)):[]); state.view==='saved'?render():syncSaved(); } catch { /* Ignore malformed external state. */ }
  });
  window.addEventListener('hashchange',handleHash);
  window.addEventListener('popstate',handleHash);
  if (publishedSchedules.length) {
    availabilityToggle.hidden = false;
    refreshAvailability();
    document.addEventListener('visibilitychange', refreshAvailability);
    window.addEventListener('pageshow', refreshAvailability);
  }
  let hintFrame = 0;
  const scrollHintObserver = 'ResizeObserver' in window ? new ResizeObserver(scheduleScrollHints) : null;
  let observedDetail = null;
  function scheduleScrollHints() {
    if (hintFrame) return;
    hintFrame = requestAnimationFrame(() => { hintFrame=0; syncScrollHints(); });
  }
  function syncScrollHints() {
    const areas = $('.areas');
    const moreAreas = areas.scrollHeight-areas.clientHeight-areas.scrollTop > 12;
    $('.sidebar-scroll-cue').hidden = !moreAreas;
    $('.sidebar-section').classList.toggle('has-scroll-more',moreAreas);
    const scroller = $('.dialog-scroll',placeDialog), cue = $('.detail-scroll-cue',placeDialog);
    if (cue && scroller) {
      placeDialog.classList.toggle('is-scrolled',scroller.scrollTop > 90);
      const more = scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop > 24;
      cue.hidden = !more;
    }
  }
  function observeDetailScroll() {
    if (observedDetail) scrollHintObserver?.unobserve(observedDetail);
    observedDetail = $('.dialog-content',placeDialog);
    if (observedDetail) scrollHintObserver?.observe(observedDetail);
    scheduleScrollHints();
  }
  $('.areas').addEventListener('scroll',scheduleScrollHints,{passive:true});
  window.addEventListener('resize',scheduleScrollHints,{passive:true});
  [$('.sidebar-section'),placeDialog].forEach(element => scrollHintObserver?.observe(element));
  const initialArea=location.pathname.match(/^\/area\/([a-z0-9-]+)\/?$/);
  if(initialArea) state.area=data.areas.find(item=>slugForArea(item)===initialArea[1]) || 'all';
  if(placeDialog.dataset.prerendered) syncControls(); else animateUpdate(render);
  syncTheme(); handleHash();
})();

