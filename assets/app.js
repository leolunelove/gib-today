
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
  const state = { view: 'explore', query: '', area: 'all', cuisine: 'all', collection: 'all', sort: 'directory', online: false, delivery: 'all', layout: storage.get('layout', 'grid') === 'list' ? 'list' : 'grid', saved: new Set(savedIds) };
  const grid = $('#restaurant-grid');
  const placeDialog = $('#place-dialog');
  const infoDialog = $('#info-dialog');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const checkedDate = new Intl.DateTimeFormat('en-GB', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(`${data.checkedAt}T12:00:00Z`));
  let currentVenue = null;
  const dialogClosers = new Map();
  const dialogFocus = new WeakMap();
  const motion = { quick: 160, move: 320, enter: 360, exit: 200, ease: 'cubic-bezier(.22,1,.36,1)' };
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
  function animateUpdate(update) {
    // Retain cards and images. Read all positions before writing animation styles.
    const previous = new Map();
    if (!reducedMotion.matches) $$('.restaurant-card', grid).forEach(card => {
      const rect = card.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < innerHeight) previous.set(card.dataset.venue, rect);
      card.getAnimations().forEach(animation => animation.cancel());
    });
    update();
    if (reducedMotion.matches) return;
    const visible = $$('.restaurant-card', grid).map(card => [card, card.getBoundingClientRect()])
      .filter(([,rect]) => rect.bottom > 0 && rect.top < innerHeight);
    visible.forEach(([card, after], index) => {
      const before = previous.get(card.dataset.venue);
      if (!before) {
        card.dataset.arrived = 'true';
        playMotion(card, [{opacity:0, transform:'translateY(12px)'},{opacity:1, transform:'none'}],
          {duration:motion.enter, delay:Math.min(index,5)*24, fill:'backwards'});
        return;
      }
      const dx = before.left-after.left, dy = before.top-after.top;
      // Distant sort results settle locally instead of flying through the page.
      if (Math.abs(dx)+Math.abs(dy)<2) return;
      if (Math.abs(dy)>innerHeight*.7) return;
      playMotion(card, [{transform:`translate(${dx}px, ${dy}px)`},{transform:'none'}]);
    });
  }
  const cardCache = new Map();
  const cardObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    entries.forEach(({target,isIntersecting}) => {
      if (!isIntersecting) return;
      cardObserver.unobserve(target);
      if (target.dataset.arrived) return;
      target.dataset.arrived = 'true';
      playMotion(target,[{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'none'}],{duration:motion.enter});
    });
  },{threshold:.01,rootMargin:'0px 0px 48px 0px'}) : null;
  function renderCards(matches) {
    const focused = document.activeElement;
    const focusedCard = focused?.closest('.restaurant-card');
    const oldIndex = focusedCard ? [...grid.children].indexOf(focusedCard) : -1;
    const wanted = new Set(matches.map(venue => venue.id));
    [...grid.children].forEach(child => { if (!wanted.has(child.dataset.venue)) { cardObserver?.unobserve(child); child.remove(); } });
    if (!matches.length) { grid.innerHTML = emptyState(); }
    else matches.forEach((venue, index) => {
      let node = cardCache.get(venue.id);
      if (!node) {
        const template = document.createElement('template');
        template.innerHTML = card(venue,index);
        node = template.content.firstElementChild;
        cardCache.set(venue.id,node);
      }
      const current = grid.children[index];
      if (current !== node) grid.insertBefore(node,current || null);
      if (!node.dataset.arrived) cardObserver?.observe(node);
    });
    if (focusedCard && !document.contains(focused)) {
      const next = grid.children[Math.min(oldIndex,grid.children.length-1)];
      (next?.querySelector('button') || $('#results-heading')).focus({preventScroll:true});
    } else if (focusedCard && document.contains(focused) && document.activeElement !== focused) {
      focused.focus({preventScroll:true});
    }
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
    const expanded = {height:fullHeight+'px',opacity:1,paddingTop:styles.paddingTop,paddingBottom:styles.paddingBottom,marginBottom:styles.marginBottom,borderTopWidth:'1px',borderBottomWidth:'1px'};
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
      return (state.view !== 'saved' || state.saved.has(venue.id)) && (state.area === 'all' || venue.area === state.area) && (state.cuisine === 'all' || venue.cuisine === state.cuisine) && (state.collection === 'all' || (venue.collections || []).includes(state.collection)) && (!state.online || Boolean(venue.reservationUrl)) && (state.delivery === 'all' || (venue.delivery || []).some(l=>state.delivery === 'any' || l.provider === state.delivery)) && terms.every(term => haystack.includes(term));
    });
    if (state.sort === 'az') result.sort((a,b) => a.name.localeCompare(b.name, 'en'));
    if (state.sort === 'za') result.sort((a,b) => b.name.localeCompare(a.name, 'en'));
    return result;
  }
  function coverHTML(venue, index = 0, detail = false) {
    const e = escapeHTML;
    if (venue.image) {
      return `<img class="venue-photo" src="${e(venue.image)}" srcset="${e(venue.imageSrcSet || '')}" sizes="${detail ? '(max-width: 560px) 100vw, 560px' : '(max-width: 560px) 100vw, (max-width: 1100px) 45vw, 30vw'}" alt="${e(venue.imageAlt || venue.name)}" width="${venue.imageWidth || 960}" height="${venue.imageHeight || 640}" style="object-position:${e(venue.imagePosition || '50% 50%')}" loading="${detail || index < 3 ? 'eager' : 'lazy'}" decoding="async">${venue.imageNotice ? `<span class="image-notice">${e(venue.imageNotice)}</span>` : ''}`;
    }
    const number = String(venues.findIndex(item=>item.id===venue.id)+1).padStart(2,'0');
    return `<div class="editorial-cover" data-tone="${e(venue.coverTone || 'stone')}" aria-hidden="true"><span class="cover-kicker"><span>${e(venue.cuisine)}</span><span class="cover-number">Nº ${number}</span></span><span class="cover-title">${(venue.coverLines || [venue.name]).map(line=>`<span>${e(line)}</span>`).join('')}</span><svg class="cover-landscape" viewBox="0 0 400 180" fill="none"><path d="M0 145h400M0 159h400M0 173h400" stroke="currentColor"/><path d="M130 145l36-23 23-35 27-17 13-24 29-6 16 27 12 8 20 37 38 33Z" fill="currentColor"/><path d="M229 46l-13 24-27 17-23 35-36 23m128-105-8 35-21 26-6 44" stroke="var(--cover-bg)" stroke-width="2"/></svg><span class="cover-footer"><span>${e(venue.area)}</span><span>Explore ↗</span></span></div>`;
  }
  function contactLabel(venue) {
    if (venue.onlineOrdering) return ['globe','Order direct'];
    if ((venue.delivery || []).length) return ['globe','Menu & delivery'];
    if (venue.tradingStatus === 'unconfirmed') return ['message','Check trading status'];
    if (venue.reservationPolicy === 'walk-in') return ['compass','Walk in'];
    if (venue.reservationUrl) return ['globe','Official booking page'];
    if (venue.phone) return ['phone',venue.bookingMethod === 'call-reserve' ? 'Call to reserve' : 'Call for enquiries'];
    if (venue.email) return ['mail','Email an enquiry'];
    return ['message','Ask the venue'];
  }
  function card(venue, index) {
    const e = escapeHTML, saved = state.saved.has(venue.id);
    const label = 'View place';
    const route = `/place/${encodeURIComponent(venue.id)}/`;
    const [contactIcon, contactText] = contactLabel(venue);
    return `<article class="restaurant-card" data-venue="${e(venue.id)}" style="--i:${index}">
      <div class="card-photo-wrap"><a class="card-photo" href="${route}" data-action="open-place" data-id="${e(venue.id)}" aria-label="${label} at ${e(venue.name)}" tabindex="-1">${coverHTML(venue,index)}</a>
        <button class="save-button" data-action="save" data-id="${e(venue.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Unsave' : 'Save'} ${e(venue.name)}" title="${saved ? 'Remove from saved places' : 'Save place'}">${icon('bookmark')}</button></div>
      <div class="card-content"><div class="card-heading"><h3 class="card-title"><a href="${route}" data-action="open-place" data-id="${e(venue.id)}">${e(venue.name)}</a></h3></div>
        <p class="card-subtitle"><span>${e(venue.area)}</span><span class="sep" aria-hidden="true"></span><span>${e(venue.cuisine)}</span></p>
        <p class="card-description">${e(venue.shortDescription || venue.description)}</p>${(venue.delivery || []).length ? `<p class="card-delivery" aria-label="Delivery app listings">${venue.delivery.map(l=>`<span>${e((data.deliveryProviders || []).find(p=>p.id===l.provider)?.name || l.provider)}</span>`).join('')}</p>` : ''}
        <div class="card-bottom"><a class="review-link" href="${e(venue.tripadvisor || venue.contactSource)}" ${external} aria-label="${venue.tripadvisor?'Read Tripadvisor reviews':'View restaurant source'} for ${e(venue.name)}, opens in a new tab">${venue.tripadvisor?'Tripadvisor reviews':'Restaurant source'} ${icon('external')}</a><span class="contact-type">${icon(contactIcon)}${contactText}</span></div>
        <a class="reserve-button" href="${route}" data-action="open-place" data-id="${e(venue.id)}" aria-label="${label} at ${e(venue.name)}" tabindex="-1">${label} ${icon('arrow')}</a>
      </div></article>`;
  }
  function emptyState() {
    const entirelyEmptySaved = state.view === 'saved' && state.saved.size === 0;
    return `<div class="empty-state"><div class="empty-icon">${icon(entirelyEmptySaved ? 'bookmark' : 'search')}</div><h3>${entirelyEmptySaved ? 'Your next good idea goes here.' : 'Nothing on this corner.'}</h3><p>${entirelyEmptySaved ? 'Tap the bookmark on a restaurant to keep it here. Your places stay saved on this browser.' : 'No restaurants match these filters. Try another area or clear the search.'}</p><button class="button secondary" data-action="${entirelyEmptySaved ? 'home' : 'reset-filters'}">${entirelyEmptySaved ? 'Explore the directory' : 'Clear all filters'} ${icon('arrow')}</button></div>`;
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
    $$('[data-action="area"]').forEach(button => { const selected = button.dataset.area === state.area; button.classList.toggle('active',selected); button.setAttribute('aria-pressed',String(selected)); });
    $$('[data-action="cuisine"]').forEach(button => { const active = button.dataset.cuisine === state.cuisine; button.setAttribute('aria-pressed',String(active)); button.classList.toggle('active',active); });
    $$('[data-action="collection"]').forEach(button => { const active = button.dataset.collection === state.collection; button.setAttribute('aria-pressed',String(active)); button.classList.toggle('active',active); });
    $('#cuisine-select').value = state.cuisine;
    $$('[data-action="layout"]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.layout === state.layout)));
    $('#area-select').value = state.area;
    $('#sort-select').value = state.sort;
    $('#filter-sort').value = state.sort;
    $('#online-only').checked = state.online;
    $$('[data-action="delivery"]').forEach(button => { const active=button.dataset.delivery===state.delivery; button.setAttribute('aria-pressed',String(active)); button.classList.toggle('active',active); });
    $('#clear-search').hidden = !state.query;
    $('#search-hint').hidden = Boolean(state.query);
    $('#filter-dot').hidden = state.area === 'all' && state.cuisine === 'all' && state.collection === 'all' && !state.online && state.delivery === 'all' && state.sort === 'directory';
    $('#breadcrumb-page').textContent = state.view === 'saved' ? 'Saved places' : 'Explore';
    const pageTitle = $('#page-title');
    if (pageTitle.dataset.view !== state.view) {
      pageTitle.dataset.view = state.view;
      pageTitle.innerHTML = state.view === 'saved' ? 'Your saved places.' : 'Find somewhere<br><span class="marker-word">good.</span>';
      $('#hero-copy').textContent = state.view === 'saved' ? 'The places you want to remember, kept in this browser.' : 'Find somewhere good in Gibraltar. Restaurants, menus, delivery apps and ways to book.';
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
    if (total.textContent !== String(matches.length)) { total.textContent = matches.length; playMotion(total,[{transform:'translateY(3px)',opacity:.45},{transform:'none',opacity:1}],{duration:motion.quick}); }
    const oldHeading = $('#results-heading').textContent;
    $('#results-heading').textContent = state.view === 'saved' ? 'Your saved places' : state.area !== 'all' ? state.area : state.collection !== 'all' ? data.collections.find(c=>c.id===state.collection)?.name || 'Your collection' : hasSearch || state.cuisine !== 'all' || state.online || state.delivery !== 'all' ? 'Matching places' : 'Places';
    if (oldHeading !== $('#results-heading').textContent) playMotion($('#results-heading'),[{backgroundSize:'0% 100%'},{backgroundSize:'100% 100%'}],{duration:motion.enter});
    $('#results-status').textContent = `${matches.length} restaurant${matches.length === 1 ? '' : 's'} ${state.view === 'saved' ? 'in your saved places' : 'in the directory'}${hasSearch ? ` matching “${state.query.trim()}”` : ''}.`;
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
  }
  function resetFilters() {
    clearTimeout(searchTimeout);
    state.query = ''; state.area = 'all'; state.cuisine = 'all'; state.collection = 'all'; state.online = false; state.delivery = 'all'; state.sort = 'directory';
    $('#search-input').value = '';
    render();
  }
  function setView(view) {
    state.view = view === 'saved' ? 'saved' : 'explore';
    resetFilters();
    // A navigation change starts at the top on every screen size.
    // Avoid a long animated trip through the previous results.
    window.scrollTo({top:0,behavior:'instant'});
  }
  function toggleSaved(id, button) {
    const venue = byId.get(id); if (!venue) return;
    if (state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
    const persisted = storage.set('saved', JSON.stringify([...state.saved]));
    if (state.view === 'saved') animateUpdate(render); else syncSaved();
    if (button && document.contains(button)) playMotion($('.icon',button),[{transform:'scale(.75) rotate(-12deg)'},{transform:'scale(1.2) rotate(5deg)',offset:.55},{transform:'none'}],{duration:motion.enter});
    $$('[data-saved-count]').forEach(count=>playMotion(count,[{transform:'scale(1.3)'},{transform:'none'}],{duration:motion.move}));
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
    const e = escapeHTML, walkIn = venue.reservationPolicy === 'walk-in';
    const providers = data.deliveryProviders || [];
    const delivery = venue.delivery || [];
    const provider = id => providers.find(p => p.id === id) || {name:id,short:id};
    const action = (url,title,detail,primary=false,ico='external') => `<a class="place-action ${primary?'place-action-primary':''}" href="${e(url)}" ${external}><span><strong>${e(title)}</strong>${detail?`<small>${e(detail)}</small>`:''}</span>${icon(ico)}</a>`;
    const onlineButton = venue.reservationUrl ? action(venue.reservationUrl,venue.bookingLabel || 'Book a table','Official restaurant booking page',true,'table') : '';
    const phoneButton = venue.phone && !walkIn ? `<a class="place-action ${!venue.reservationUrl?'place-action-primary':''}" href="tel:${e(venue.phoneHref)}"><span><strong>${venue.bookingMethod==='call-reserve'?'Call to book':'Call restaurant'}</strong><small>${e(venue.phone)}</small></span>${icon('phone')}</a>` : '';
    const emailButton = venue.email && !walkIn && venue.emailBookingAllowed !== false ? `<a class="place-action" data-email-link href="mailto:${e(venue.email)}?subject=${encodeURIComponent('Dining enquiry — '+venue.name)}"><span><strong>Email an enquiry</strong><small>${data.contactSendingEnabled===false?'Online enquiries temporarily unavailable':'Ask the restaurant directly'}</small></span>${icon('mail')}</a>` : '';
    const deliveryLinks = delivery.map(link => { const p=provider(link.provider); return `<a class="delivery-option" href="${e(link.url)}" ${external}><span class="provider-mark" data-provider="${e(p.id)}">${e(p.short)}</span><span><strong>${e(p.name)}</strong><small>${e(link.availabilityNote || 'Open menu & ordering')}</small></span>${icon('external')}</a>`; }).join('');
    const sources = [...(venue.verification || []),...(venue.onlineOrdering?[{source:venue.onlineOrdering.source,checkedAt:venue.onlineOrdering.checkedAt,note:'Official direct ordering link.'}]:[]),...delivery.map(l=>({source:l.source,checkedAt:l.checkedAt,note:provider(l.provider).name+' restaurant listing.'}))];
    return `<div class="dialog-top-actions"><span class="dialog-current-name" aria-hidden="true">${e(venue.name)}</span><button class="icon-button" data-action="share-place" aria-label="Copy link to ${e(venue.name)}" title="Copy place link">${icon('link')}</button><button class="icon-button" data-action="save" data-id="${e(venue.id)}" aria-pressed="${state.saved.has(venue.id)}" aria-label="Save ${e(venue.name)}">${icon('bookmark')}</button><button class="icon-button" data-action="close-place" aria-label="Close restaurant details" autofocus>${icon('close')}</button></div><div class="dialog-scroll"><div class="dialog-photo">${coverHTML(venue,0,true)}</div>
      <div class="dialog-content"><header class="place-heading"><div class="dialog-kicker">${e(venue.area)} · ${e(venue.cuisineDetail || venue.cuisine)}</div><h2 id="place-title">${e(venue.name)}</h2><p class="dialog-description">${e(venue.description)}</p><div class="detail-tags">${venue.tags.slice(0,4).map(tag=>`<span class="detail-tag">${e(tag)}</span>`).join('')}</div><nav class="place-quick-links" aria-label="Restaurant links">${venue.menuUrl?sourceAnchor(venue.menuUrl,'Menu'):''}${venue.website?sourceAnchor(venue.website,'Website'):''}${sourceAnchor(googleMapsLink(venue),'Directions')}${['instagram','facebook'].filter(k=>venue[k]).map(k=>sourceAnchor(venue[k],k==='instagram'?'Instagram':'Facebook')).join('')}</nav></header>
      <div class="place-layout"><div class="place-main"><section class="place-section order-section" aria-labelledby="order-title"><h3 id="order-title">Order &amp; delivery</h3>${venue.onlineOrdering?`<div class="direct-order">${action(venue.onlineOrdering.url,venue.onlineOrdering.label,'Official online ordering · '+venue.onlineOrdering.provider,true,'arrow')}</div>`:''}${delivery.length?`<p class="place-eyebrow">Listed on ${delivery.length===1?'this delivery app':'these delivery apps'}</p><div class="delivery-options">${deliveryLinks}</div><p class="place-fineprint">Check the app for current availability, delivery area, fees and collection options.</p>`:`<p class="place-empty">No delivery-app listing verified yet.</p>`}${venue.alternateMenus?.length?`<details class="price-detail"><summary>More menus at this address</summary><div class="detail-links">${venue.alternateMenus.map(l=>sourceAnchor(l.url,l.name+' · '+provider(l.provider).name)).join('')}</div></details>`:''}</section>
      <section class="place-section reserve-block" aria-labelledby="reserve-title"><h3 id="reserve-title">${walkIn?'Walk in':venue.visitType==='visit-collection'?'Visit & collection':'Eat here'}</h3>${walkIn?'<p class="walkin-note">Walk-ins only, according to the official restaurant listing.</p>':`<div class="contact-buttons">${onlineButton}${phoneButton}${venue.whatsapp?action(venue.whatsapp,'Message on WhatsApp','Contact the restaurant'):''}${emailButton}</div>`}<p class="reservation-note">${e(venue.reservationNote)}</p>${!walkIn && venue.emailBookingAllowed===false && venue.email?`<div class="detail-links">${sourceAnchor('mailto:'+venue.email,'General email · not bookings')}</div>`:''}</section></div>
      <aside class="place-rail" aria-label="Plan your visit"><section class="visit-panel"><h3>Plan your visit</h3><div class="visit-fact"><span class="place-eyebrow">Find it</span><address>${e(venue.address)}</address><a href="${e(googleMapsLink(venue))}" ${external}>Get directions ${icon('arrow')}</a></div><div class="visit-fact"><span class="place-eyebrow">Opening hours</span><p>${e(venue.hours || 'Hours not verified. Check with the restaurant before visiting.')}</p></div><details class="price-detail"><summary>Menu &amp; price notes</summary><p>${e(venue.priceNote || 'See the current menu for prices.')}</p></details></section></aside></div>
      <footer class="place-footer"><details class="source-details"><summary>Sources &amp; things to know</summary><p>Restaurant details checked ${e(venue.checkedAt || data.checkedAt)}. Delivery listings checked ${e(venue.deliveryCheckedAt || data.deliveryCheckedAt)}. Listings do not mean a restaurant is accepting orders right now.</p>${(venue.auditIssues || []).length?`<ul>${venue.auditIssues.map(issue=>`<li>${e(issue)}</li>`).join('')}</ul>`:''}${sources.map(check=>`<p>${check.linkStatus==='unrelated-redirect'?e('Former website withheld: '+check.source):sourceAnchor(check.source,'Source · '+check.checkedAt)}${check.note?`<small>${e(check.note)}</small>`:''}</p>`).join('')}${venue.image?`<p>${sourceAnchor(venue.imageSource,venue.imageCredit)}<small>${e(venue.imageRightsStatus || '')}</small></p>`:''}<p class="source-footnote">Independent directory. Orders and table bookings are handled by the restaurant or delivery provider.</p></details><div class="trust-links"><a href="mailto:${e(data.contactEmail)}?subject=${encodeURIComponent('Correction: '+venue.name)}">Report incorrect information</a><a href="mailto:${e(data.contactEmail)}?subject=${encodeURIComponent('Owner update: '+venue.name)}">Restaurant owner? Update this listing</a></div></footer>
      <section class="detail-section nearby-section"><h3>More in ${e(venue.area)}</h3>${venues.filter(other=>other.id!==venue.id && other.area===venue.area).slice(0,2).map(other=>`<button class="similar-place" data-action="open-place" data-id="${e(other.id)}"><span>${e(other.name)}<small> · ${e(other.cuisine)}</small></span>${icon('arrow')}</button>`).join('') || '<p>More nearby places are being researched.</p>'}</section></div></div><div class="dialog-toast" role="status" aria-live="polite">${icon('check')}<span class="dialog-toast-message"></span></div>`;
  }
  function showPlace(id, changeHash = true) {
    const venue = byId.get(id); if (!venue) return;
    if (infoDialog.open) infoDialog.close();
    const replacing = placeDialog.open;
    cancelDialogClose(placeDialog);
    if (!replacing) { priorDialogFocus = document.activeElement; dialogFocus.set(placeDialog,priorDialogFocus); }
    currentVenue = venue;
    placeDialog.innerHTML = venueDialogHTML(venue);
    prepareDisclosures(placeDialog);
    if (!placeDialog.open) placeDialog.showModal();
    syncScrollLock();
    placeDialog.classList.remove('is-scrolled');
    const scroller = placeDialog.querySelector('.dialog-scroll');
    scroller.scrollTop = 0;
    let scrollFrame = 0;
    scroller.addEventListener('scroll',()=>{
      if (scrollFrame) return;
      scrollFrame=requestAnimationFrame(()=>{placeDialog.classList.toggle('is-scrolled',scroller.scrollTop>100);scrollFrame=0;});
    },{passive:true});
    $('[data-action="close-place"]',placeDialog).focus({preventScroll:true});
    if (replacing) playMotion($('.dialog-content',placeDialog),[{opacity:.25,transform:'translateY(8px)'},{opacity:1,transform:'none'}]);
    if (changeHash) history[replacing?'replaceState':'pushState']({tablePlace:true},'',`/place/${encodeURIComponent(id)}/`);
    updateMetadata(venue);
    updateMessage();
    syncSaved();
  }
  function syncScrollLock() {
    document.documentElement.style.overflow = document.querySelector('dialog[open]') ? 'hidden' : '';
  }
  function cancelDialogClose(dialog) {
    const timer = dialogClosers.get(dialog);
    if (timer) clearTimeout(timer);
    dialogClosers.delete(dialog);
    dialog.classList.remove('closing');
    dialog.style.removeProperty('--dialog-exit-opacity');
    dialog.style.removeProperty('--dialog-exit-transform');
  }
  function closeDialog(dialog) {
    if (!dialog.open || dialogClosers.has(dialog)) return;
    if (dialog === placeDialog && !routeClosing) {
      if (history.state?.tablePlace) { history.back(); return; }
      history.replaceState(null,'','/'); updateMetadata(null);
    }
    const appearance = getComputedStyle(dialog);
    dialog.style.setProperty('--dialog-exit-opacity',appearance.opacity);
    dialog.style.setProperty('--dialog-exit-transform',appearance.transform);
    dialog.classList.add('closing');
    const finish = () => {
      dialogClosers.delete(dialog); dialog.close(); dialog.classList.remove('closing');
    };
    if (reducedMotion.matches) finish();
    else dialogClosers.set(dialog,setTimeout(finish,motion.exit));
  }
  function onDialogClosed(dialog) {
    // A queued native close event must not clear a newly reopened dialog.
    if (dialog.open) return;
    cancelDialogClose(dialog);
    if (dialog === placeDialog) { currentVenue = null; updateMetadata(null); }
    syncScrollLock();
    const focus = dialogFocus.get(dialog);
    const topDialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (focus?.isConnected && focus !== document.body && (!topDialog || topDialog.contains(focus))) focus.focus({preventScroll:true});
    else if (!topDialog) $('#search-input').focus({preventScroll:true});
  }
  function infoHTML(page) {
    const sources = page === 'sources';
    const sourceEntries = (sources ? venues : []).map(venue => `<details><summary>${escapeHTML(venue.name)}</summary>${sourceAnchor(venue.contactSource,venue.contactSourceName)}${venue.tripadvisor?sourceAnchor(venue.tripadvisor,'Tripadvisor review listing'):''}<small>${escapeHTML(venue.contactProvenance)}</small></details>`).join('');
    return `<div class="info-toolbar"><span class="popup-current-name" aria-hidden="true">${sources ? 'About & sources' : 'A little guidance'}</span><button class="icon-button close-info" data-action="close-info" aria-label="Close guide" autofocus>${icon('close')}</button></div><div class="info-content"><div class="info-mark">${icon('table')}</div><h2 id="info-title">${sources ? 'A clear little<br><span class="marker-word">directory.</span>' : 'Good food.<br><span class="marker-word">Your kind of plan.</span>'}</h2>${sources ? `<p class="info-intro">An independent starting point for eating out in Gibraltar. ${venues.length} selected places across ${data.areas.length} neighbourhoods. Not a complete list, and not a paid ranking.</p><h3>What makes it into the directory?</h3><p>A Gibraltar location and current restaurant or delivery-menu evidence, with a published way to contact, order from or visit the business. The selection covers a spread of cuisines, neighbourhoods and meal types. Inclusion is not a quality rating, first-hand review or partnership.</p><h3>Published details, not live availability.</h3><p>Original package check: ${checkedDate}. Individual listings show their latest check date. Some entries still await a fresh full check. Opening hours and availability are not inferred. Tripadvisor scores and review counts stay on Tripadvisor, where you can read the current listing.</p><div class="source-list">${sourceEntries}</div><h3>A note on the photography</h3><p>The directory uses venue images from business websites, delivery menus, official tourism pages and credited venue galleries. Promotional artwork is labelled. Sources are linked on each listing. Some source images are promotional graphics or archival photographs. They do not establish current trading status. Image sources are credited; original photographer and reuse permissions have not been independently confirmed. Editorial covers remain as a fallback if an image cannot load. No generated images are presented as restaurant photographs.</p><h3>Your browser. Your saved places.</h3><p>Saved places, layout and appearance are stored only in this browser. There are no accounts, tracking scripts, booking records or advertising cookies. Clearing browser data removes your saved places. Contact messages are delivered through an email service to the recipient shown. Limited delivery and abuse-prevention records are kept; message bodies are not stored by this directory. External websites have their own privacy practices.</p><button class="button secondary" data-action="theme">${icon('moon')}Change appearance</button>` : `<p class="info-intro">For the “where shall we eat?” moments. Find a place on the Rock, then take it from there.</p><div class="steps"><div class="step"><span class="step-number">01</span><div><h3>Follow your appetite.</h3><p>A coffee around the corner. Dinner by the water. Explore by neighbourhood or cuisine, and bookmark the ones that catch your eye.</p></div></div><div class="step"><span class="step-number">02</span><div><h3>Eat in. Order out.</h3><p>Open a restaurant for its menu, visit details, direct ordering and verified delivery-app listings. Booking links and walk-in guidance live there too.</p></div></div><div class="step"><span class="step-number">03</span><div><h3>Make it a plan.</h3><p>Call the restaurant, follow its booking link or open your delivery app. Check today’s hours before heading over. The restaurant or provider confirms your booking or order.</p></div></div></div><div class="info-callout">A little local guide, with no account or booking fee. Restaurants and delivery apps handle availability, orders and reservations directly.</div><button class="text-button" data-action="info" data-page="sources">Read about the directory and its sources</button>`}<div class="info-bottom"><span>Find somewhere good.</span></div></div>`;
  }
  function showInfo(page) {
    cancelDialogClose(infoDialog);
    if (placeDialog.open) placeDialog.close();
    const replacing = infoDialog.open;
    if (!infoDialog.open) dialogFocus.set(infoDialog,document.activeElement);
    infoDialog.innerHTML = infoHTML(page);
    prepareDisclosures(infoDialog);
    if (!infoDialog.open) infoDialog.showModal();
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
  function setTheme() {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    storage.set('theme',dark ? 'dark' : 'light');
    $('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    syncTheme();
  }
  function syncTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    $('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    $$('.sidebar [data-action="theme"]').forEach(button => { button.innerHTML = icon(dark ? 'sun' : 'moon'); button.setAttribute('aria-label',`Switch to ${dark ? 'light' : 'dark'} appearance`); });
  }
  let routeClosing = false;
  function updateMetadata(venue) {
    const title = venue ? `${venue.name} · Gib .today` : 'Gib .today · Places to eat in Gibraltar';
    const description = venue?.description || 'Find somewhere good in Gibraltar. Restaurants, menus, delivery apps and ways to book.';
    document.title = title;
    $('meta[name="description"]').content = description;
    $('meta[property="og:title"]').content = title;
    $('meta[property="og:description"]').content = description;
    const url = `https://gib.today${venue ? `/place/${venue.id}/` : '/'}`;
    $('link[rel="canonical"]').href = url; $('meta[property="og:url"]').content = url;
  }
  function handleHash() {
    const match = location.pathname.match(/^\/place\/([a-z0-9-]+)\/?$/) || location.hash.match(/^#place\/([a-z0-9-]+)$/);
    if (contactDialog.open) contactDialog.close();
    if (match && byId.has(match[1])) showPlace(match[1],false);
    else if (placeDialog.open) { routeClosing=true; closeDialog(placeDialog); routeClosing=false; }
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
    contactDialog.showModal();
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
    const emailTitle = editorialEmail ? (/correction/i.test(subject) ? 'Spotted something off?' : /suggest/i.test(subject) ? 'A place worth adding?' : /owner|listing update/i.test(subject) ? 'Keep your place up to date.' : 'Get in touch.') : 'Email the restaurant';
    if (phone) {
      contactDialog.innerHTML = `<form class="contact-form contact-phone"><button type="button" class="icon-button contact-close" aria-label="Close contact form" autofocus>${icon('close')}</button><p class="dialog-kicker">${escapeHTML(currentVenue?.name || 'Restaurant contact')}</p><h2 id="contact-title">Give them a ring.</h2><p class="contact-phone-number">${escapeHTML(currentVenue?.phone || decodeURIComponent(contactTarget.pathname))}</p><p>Your phone app will open with the restaurant’s number. The restaurant can confirm tables and today’s hours.</p><button class="button primary" type="submit">Continue to call ${icon('phone')}</button><p class="source-footnote">You complete the call in your phone app.</p></form>`;
      showContact(link);
      return;
    }
    if (email && data.contactSendingEnabled === false) {
      const restaurantEmail = decodeURIComponent(contactTarget.pathname).toLowerCase() !== data.contactEmail.toLowerCase();
      const title = /correction/i.test(subject) ? 'Spotted something off?' : /suggest/i.test(subject) ? 'A place worth adding?' : /owner|listing update/i.test(subject) ? 'Keep your place up to date.' : 'Get in touch.';
      contactDialog.innerHTML = `<div class="contact-form"><button type="button" class="icon-button contact-close" aria-label="Close contact form" autofocus>${icon('close')}</button><p class="dialog-kicker">${/correction/i.test(subject) ? 'Corrections' : /suggest/i.test(subject) ? 'Suggestions' : /owner|listing update/i.test(subject) ? 'Listing updates' : 'Contact'}</p><h2 id="contact-title">${title}</h2><div class="contact-unavailable"><strong>Messages are taking a breather.</strong><p>Online enquiries are temporarily unavailable.${restaurantEmail ? ' You can still use this restaurant’s phone, WhatsApp or official booking link where listed.' : ' Please check back to send a suggestion or update.'}</p></div><button class="button secondary contact-back" type="button">${currentVenue ? 'Back to the restaurant' : 'Back to exploring'} ${icon('arrow')}</button></div>`;
      showContact(link);
      return;
    }
    contactDialog.innerHTML = `<form class="contact-form"><button type="button" class="icon-button contact-close" aria-label="Close contact form">${icon('close')}</button><p class="dialog-kicker">${email ? 'Email enquiry' : phone ? 'Phone enquiry' : 'WhatsApp enquiry'}</p><h2 id="contact-title">${escapeHTML(email ? emailTitle : subject)}</h2><p>${email ? 'Send your message here. Replies go to the email address you provide.' : phone ? 'Add a note for your call, then open your phone app.' : 'Prepare your message, then send it in WhatsApp.'}</p><label>Your name${email ? '' : ' (optional)'}<input name="name" autocomplete="name" ${email ? 'required' : ''} maxlength="100" placeholder="Name"></label>${email ? '<label>Your email<input name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"></label><div class="contact-honeypot" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>' : ''}<label>Message<textarea name="message" rows="5" maxlength="5000" required placeholder="Your message…"></textarea></label><p class="contact-destination">To: ${escapeHTML(editorialEmail ? 'Site editor' : email || phone ? decodeURIComponent(contactTarget.pathname) : currentVenue?.name || 'Restaurant')}</p><button class="button primary" type="submit">${phone ? 'Continue to call' : email ? 'Send message' : 'Open WhatsApp to send'} ${icon('arrow')}</button><p class="source-footnote">${email ? 'Your name, email and message are sent to the recipient shown above.' + (editorialEmail ? '' : ' Table enquiries need restaurant confirmation.') : 'You complete the action in the next app.'}</p><p class="contact-status" role="status" aria-live="polite"></p></form>`;
    contactDialog.querySelector('textarea').value = contactTarget.searchParams.get('body') || '';
    showContact(link);
  }
  function showContactSuccess(form, payload, kind, venue) {
    const previousHeight = contactDialog.getBoundingClientRect().height;
    const screen = document.createElement('section');
    screen.className = 'contact-success';
    const thanks = {suggestion:'Thanks for sharing a place worth knowing.', correction:'Thanks for helping keep the details right.', owner:'Thanks for sending your listing update.', general:'Thanks for getting in touch.'};
    screen.innerHTML = `<div class="contact-success-stamp" aria-hidden="true">${icon('check')}</div><p class="dialog-kicker">All done</p><h2 id="contact-title" tabindex="-1"><span class="marker-word">Message sent.</span></h2><p class="contact-success-copy">${kind === 'restaurant' ? `Your enquiry is on its way to ${escapeHTML(venue.name)}${/[.!?]$/.test(venue.name) ? '' : '.'}` : thanks[kind]}</p><div class="contact-reply-note">${icon('mail')}<p>Replies go to<strong>${escapeHTML(payload.email)}</strong></p></div>${kind === 'restaurant' ? '<p class="contact-success-note">The restaurant will need to reply to confirm any booking.</p>' : ''}<button type="button" class="button primary contact-done">${placeDialog.open ? 'Back to the restaurant' : 'Back to exploring'} ${icon('arrow')}</button>`;
    form.replaceWith(screen);
    $('.popup-current-name',contactDialog).textContent = 'Message sent.';
    contactDialog.scrollTop = 0;
    contactDialog.classList.remove('is-scrolled');
    $('.contact-done',screen).onclick = () => closeDialog(contactDialog);
    if (contactDialog.open && !contactDialog.classList.contains('closing')) {
      const nextHeight = contactDialog.getBoundingClientRect().height;
      playMotion(contactDialog,[{height:`${previousHeight}px`,overflow:'hidden'},{height:`${nextHeight}px`,overflow:'hidden'}]);
      playMotion(screen,[{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'none'}],{duration:motion.enter});
      playMotion($('.contact-success-stamp',screen),[{transform:'rotate(-12deg) scale(.8)'},{transform:'rotate(-5deg) scale(1)'}],{duration:motion.enter});
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
      case 'area': animateUpdate(()=>{ state.view = 'explore'; state.area = button.dataset.area; render(); }); break;
      case 'collection': animateUpdate(()=>{ state.collection = state.collection === button.dataset.collection ? 'all' : button.dataset.collection; render(); }); break;
      case 'clear-collection': state.collection='all'; animateUpdate(render); break;
      case 'cuisine': animateUpdate(()=>{ state.cuisine = button.dataset.cuisine; render(); }); break;
      case 'layout':
        if (state.layout === button.dataset.layout) break;
        animateUpdate(()=>{ state.layout = button.dataset.layout; storage.set('layout',state.layout); render(); });
        $$('.card-content',grid).forEach(content=>{const box=content.getBoundingClientRect();if(box.top<innerHeight&&box.bottom>0) playMotion(content,[{opacity:.4},{opacity:1}],{duration:motion.quick});});
        break;
      case 'save': toggleSaved(button.dataset.id, button); break;
      case 'open-place':
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) break;
        event.preventDefault(); showPlace(button.dataset.id); break;
      case 'close-place': closeDialog(placeDialog); break;
      case 'close-info': closeDialog(infoDialog); break;
      case 'info': showInfo(button.dataset.page); break;
      case 'theme': setTheme(); break;
      case 'focus-search': $('#search-input').focus(); break;
      case 'clear-search': clearTimeout(searchTimeout); state.query = ''; $('#search-input').value=''; animateUpdate(render); $('#search-input').focus(); break;
      case 'reset-filters': animateUpdate(resetFilters); break;
      case 'clear-cuisine': state.cuisine='all'; animateUpdate(render); break;
      case 'clear-area': state.area='all'; animateUpdate(render); break;
      case 'delivery': state.delivery=button.dataset.delivery; animateUpdate(render); break;
      case 'clear-delivery': state.delivery='all'; animateUpdate(render); break;
      case 'clear-online': state.online=false; animateUpdate(render); break;
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
  $('#area-select').addEventListener('change',event => { state.area=event.target.value; animateUpdate(render); });
  $('#cuisine-select').addEventListener('change',event => { state.cuisine=event.target.value; animateUpdate(render); });
  $('#online-only').addEventListener('change',event => { state.online=event.target.checked; animateUpdate(render); });
  ['#sort-select','#filter-sort'].forEach(selector=>$(selector).addEventListener('change',event=>{ state.sort=event.target.value; animateUpdate(render); }));
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
    if (event.key!=='table.v1.saved') return;
    try { const parsed=JSON.parse(event.newValue||'[]'); state.saved=new Set(Array.isArray(parsed)?parsed.filter(id=>byId.has(id)):[]); state.view==='saved'?render():syncSaved(); } catch { /* Ignore malformed external state. */ }
  });
  window.addEventListener('hashchange',handleHash);
  window.addEventListener('popstate',handleHash);
  animateUpdate(render); syncTheme(); handleHash();
})();

