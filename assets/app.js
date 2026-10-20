
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
  let closing = false;
  let toastTimeout;
  let searchTimeout;
  let priorDialogFocus = null;
  const normalise = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').toLocaleLowerCase('en-GB');

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
  function animateUpdate(update) {
    // Apply state immediately. Native element animations avoid full-page snapshots
    // and never put an animation promise in front of a search/filter response.
    const previous = new Map();
    if (!reducedMotion.matches) $$('.restaurant-card', grid).forEach(card => previous.set(card.dataset.venue, card.getBoundingClientRect()));
    update();
    if (reducedMotion.matches) return;
    $$('.restaurant-card', grid).forEach(card => {
      const before = previous.get(card.dataset.venue);
      if (!before || !card.animate) return;
      const after = card.getBoundingClientRect();
      const dx = before.left - after.left, dy = before.top - after.top;
      if (Math.abs(dx) + Math.abs(dy) < 2) return;
      card.animate([
        { transform: `translate(${dx}px, ${dy}px)`, opacity: .7 },
        { transform: 'translate(0, 0)', opacity: 1 }
      ], { duration: 280, easing: 'cubic-bezier(.22,1,.36,1)' });
    });
  }
  function getFiltered() {
    const terms = normalise(state.query.trim()).split(/\s+/).filter(Boolean);
    const result = venues.filter(venue => {
      const haystack = normalise([venue.name, venue.area, venue.cuisine, venue.description, ...(venue.delivery || []).map(l=>(data.deliveryProviders || []).find(p=>p.id===l.provider)?.name || l.provider), ...venue.tags].join(' '));
      return (state.view !== 'saved' || state.saved.has(venue.id)) && (state.area === 'all' || venue.area === state.area) && (state.cuisine === 'all' || venue.cuisine === state.cuisine) && (state.collection === 'all' || (venue.collections || []).includes(state.collection)) && (!state.online || Boolean(venue.reservationUrl)) && (state.delivery === 'all' || (venue.delivery || []).some(l=>state.delivery === 'any' || l.provider === state.delivery)) && terms.every(term => haystack.includes(term));
    });
    if (state.sort === 'az') result.sort((a,b) => a.name.localeCompare(b.name, 'en'));
    if (state.sort === 'za') result.sort((a,b) => b.name.localeCompare(a.name, 'en'));
    return result;
  }
  function coverHTML(venue, index = 0, detail = false) {
    const e = escapeHTML;
    if (venue.image) {
      return `<img class="venue-photo" src="${e(venue.image)}" srcset="${e(venue.imageSrcSet || '')}" sizes="${detail ? '(max-width: 560px) 100vw, 560px' : '(max-width: 560px) 100vw, (max-width: 1100px) 45vw, 30vw'}" alt="${e(venue.imageAlt || venue.name)}" width="${venue.imageWidth || 960}" height="${venue.imageHeight || 640}" style="object-position:${e(venue.imagePosition || '50% 50%')}" loading="${detail || index < 3 ? 'eager' : 'lazy'}" decoding="async">`;
    }
    const number = String(venues.findIndex(item=>item.id===venue.id)+1).padStart(2,'0');
    return `<div class="editorial-cover" data-tone="${e(venue.coverTone || 'stone')}" aria-hidden="true"><span class="cover-kicker"><span>${e(venue.cuisine)}</span><span class="cover-number">Nº ${number}</span></span><span class="cover-title">${(venue.coverLines || [venue.name]).map(line=>`<span>${e(line)}</span>`).join('')}</span><svg class="cover-landscape" viewBox="0 0 400 180" fill="none"><path d="M0 145h400M0 159h400M0 173h400" stroke="currentColor"/><path d="M130 145l36-23 23-35 27-17 13-24 29-6 16 27 12 8 20 37 38 33Z" fill="currentColor"/><path d="M229 46l-13 24-27 17-23 35-36 23m128-105-8 35-21 26-6 44" stroke="var(--cover-bg)" stroke-width="2"/></svg><span class="cover-footer"><span>${e(venue.area)}</span><span>Gib .today ↗</span></span></div>`;
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
    const [contactIcon, contactText] = contactLabel(venue);
    return `<article class="restaurant-card" data-venue="${e(venue.id)}" style="--i:${index}">
      <div class="card-photo-wrap"><button class="card-photo" data-action="open-place" data-id="${e(venue.id)}" aria-label="${label} at ${e(venue.name)}">${coverHTML(venue,index)}</button>
        <button class="save-button" data-action="save" data-id="${e(venue.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Unsave' : 'Save'} ${e(venue.name)}" title="${saved ? 'Remove from saved places' : 'Save place'}">${icon('bookmark')}</button></div>
      <div class="card-content"><div class="card-heading"><h3 class="card-title"><button data-action="open-place" data-id="${e(venue.id)}">${e(venue.name)}</button></h3></div>
        <p class="card-subtitle"><span>${e(venue.area)}</span><span class="sep" aria-hidden="true"></span><span>${e(venue.cuisine)}</span></p>
        <p class="card-description">${e(venue.shortDescription || venue.description)}</p>${(venue.delivery || []).length ? `<p class="card-delivery" aria-label="Delivery app listings">${venue.delivery.map(l=>`<span>${e((data.deliveryProviders || []).find(p=>p.id===l.provider)?.name || l.provider)}</span>`).join('')}</p>` : ''}
        <div class="card-bottom"><a class="review-link" href="${e(venue.tripadvisor)}" ${external} aria-label="Read reviews of ${e(venue.name)} on Tripadvisor, opens in a new tab">Tripadvisor reviews ${icon('external')}</a><span class="contact-type">${icon(contactIcon)}${contactText}</span></div>
        <button class="reserve-button" data-action="open-place" data-id="${e(venue.id)}" aria-label="${label} at ${e(venue.name)}">${label} ${icon('arrow')}</button>
      </div></article>`;
  }
  function emptyState() {
    const entirelyEmptySaved = state.view === 'saved' && state.saved.size === 0;
    return `<div class="empty-state"><div class="empty-icon">${icon(entirelyEmptySaved ? 'bookmark' : 'search')}</div><h3>${entirelyEmptySaved ? 'A little list of possibilities.' : 'No tables on this page. Yet.'}</h3><p>${entirelyEmptySaved ? 'Tap the bookmark on a restaurant to keep it here. Your places stay saved on this browser.' : 'No restaurants match these filters. Try another area or clear the search.'}</p><button class="button secondary" data-action="${entirelyEmptySaved ? 'home' : 'reset-filters'}">${entirelyEmptySaved ? 'Explore the directory' : 'Clear all filters'} ${icon('arrow')}</button></div>`;
  }
  function syncSaved() {
    $$('[data-saved-count]').forEach(el => { el.textContent = state.saved.size; });
    $$('[data-action="save"]').forEach(button => {
      const venue = byId.get(button.dataset.id);
      if (!venue) return;
      const saved = state.saved.has(venue.id);
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
    $('#page-title').innerHTML = state.view === 'saved' ? 'Your saved places.' : 'Find somewhere<br><span class="marker-word">good.</span>';
    $('#hero-copy').textContent = state.view === 'saved' ? 'The places you want to remember, kept in this browser.' : 'Curated places to eat in Gibraltar, with the simplest way to reserve.';
    syncSaved();
  }
  function render() {
    const matches = getFiltered();
    grid.classList.toggle('list-mode',state.layout === 'list');
    grid.innerHTML = matches.length ? matches.map(card).join('') : emptyState();
    $('#result-total').textContent = matches.length;
    $('#results-heading').textContent = state.view === 'saved' ? 'Your saved places' : state.area !== 'all' ? state.area : state.collection !== 'all' ? data.collections.find(c=>c.id===state.collection)?.name || 'Your collection' : state.query || state.cuisine !== 'all' || state.online || state.delivery !== 'all' ? 'Matching places' : 'Places';
    $('#results-status').textContent = `${matches.length} restaurant${matches.length === 1 ? '' : 's'} ${state.view === 'saved' ? 'in your saved places' : 'in the directory'}${state.query ? ` matching ${state.query}` : ''}.`;
    const tokens = [];
    if (state.cuisine !== 'all') tokens.push(`<button class="active-token" data-action="clear-cuisine">${escapeHTML(state.cuisine)} ${icon('close')}</button>`);
    if (state.area !== 'all') tokens.push(`<button class="active-token" data-action="clear-area" aria-label="Remove neighbourhood filter">${escapeHTML(state.area)} ${icon('close')}</button>`);
    if (state.collection !== 'all') tokens.push(`<button class="active-token" data-action="clear-collection" aria-label="Remove collection filter">${escapeHTML(data.collections.find(c=>c.id===state.collection)?.name || 'Collection')} ${icon('close')}</button>`);
    if (state.online) tokens.push(`<button class="active-token" data-action="clear-online">Online reservation page ${icon('close')}</button>`);
    if (state.delivery !== 'all') tokens.push(`<button class="active-token" data-action="clear-delivery">${escapeHTML(state.delivery==='any'?'Delivery apps':data.deliveryProviders.find(p=>p.id===state.delivery)?.name || 'Delivery')} ${icon('close')}</button>`);
    $('#active-filters').innerHTML = tokens.join('');
    $('#active-filters').hidden = !tokens.length;
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
    // On mobile keep a page switch anchored at the top, without forced smooth scrolling.
    if (matchMedia('(max-width:55em)').matches) window.scrollTo({top:0,behavior:'instant'});
  }
  function toggleSaved(id, button) {
    const venue = byId.get(id); if (!venue) return;
    if (state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
    const persisted = storage.set('saved', JSON.stringify([...state.saved]));
    if (state.view === 'saved') render(); else syncSaved();
    if (button && document.contains(button)) { button.classList.remove('bounce'); void button.offsetWidth; button.classList.add('bounce'); }
    notify(persisted ? (state.saved.has(id) ? 'Saved to your places' : 'Removed from saved places') : 'Saved for this visit. Browser storage is unavailable.');
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
    const deliveryLinks = delivery.map(link => { const p=provider(link.provider); return `<a class="delivery-option" href="${e(link.url)}" ${external}><span class="provider-mark" data-provider="${e(p.id)}">${e(p.short)}</span><span><strong>${e(p.name)}</strong><small>Open menu &amp; ordering</small></span>${icon('external')}</a>`; }).join('');
    const sources = [...(venue.verification || []),...(venue.onlineOrdering?[{source:venue.onlineOrdering.source,checkedAt:venue.onlineOrdering.checkedAt,note:'Official direct ordering link.'}]:[]),...delivery.map(l=>({source:l.source,checkedAt:l.checkedAt,note:provider(l.provider).name+' restaurant listing.'}))];
    return `<div class="dialog-scroll"><div class="dialog-photo">${coverHTML(venue,0,true)}<div class="dialog-top-actions"><button class="icon-button" data-action="share-place" aria-label="Copy link to ${e(venue.name)}" title="Copy place link">${icon('link')}</button><button class="icon-button" data-action="save" data-id="${e(venue.id)}" aria-pressed="${state.saved.has(venue.id)}" aria-label="Save ${e(venue.name)}">${icon('bookmark')}</button><button class="icon-button" data-action="close-place" aria-label="Close restaurant details" autofocus>${icon('close')}</button></div></div>
      <div class="dialog-content"><header class="place-heading"><div class="dialog-kicker">${e(venue.area)} · ${e(venue.cuisineDetail || venue.cuisine)}</div><h2 id="place-title">${e(venue.name)}</h2><p class="dialog-description">${e(venue.description)}</p><div class="detail-tags">${venue.tags.slice(0,4).map(tag=>`<span class="detail-tag">${e(tag)}</span>`).join('')}</div><nav class="place-quick-links" aria-label="Restaurant links">${venue.menuUrl?sourceAnchor(venue.menuUrl,'Menu'):''}${venue.website?sourceAnchor(venue.website,'Website'):''}${sourceAnchor(googleMapsLink(venue),'Directions')}${['instagram','facebook'].filter(k=>venue[k]).map(k=>sourceAnchor(venue[k],k==='instagram'?'Instagram':'Facebook')).join('')}</nav></header>
      <div class="place-layout"><div class="place-main"><section class="place-section order-section" aria-labelledby="order-title"><h3 id="order-title">Order &amp; delivery</h3>${venue.onlineOrdering?`<div class="direct-order">${action(venue.onlineOrdering.url,venue.onlineOrdering.label,'Official online ordering · '+venue.onlineOrdering.provider,true,'arrow')}</div>`:''}${delivery.length?`<p class="place-eyebrow">Listed on ${delivery.length===1?'this delivery app':'these delivery apps'}</p><div class="delivery-options">${deliveryLinks}</div><p class="place-fineprint">Check the app for current availability, delivery area, fees and collection options.</p>`:`<p class="place-empty">No delivery-app listing verified yet.</p>`}</section>
      <section class="place-section reserve-block" aria-labelledby="reserve-title"><h3 id="reserve-title">${walkIn?'Walk in':'Eat here'}</h3>${walkIn?'<p class="walkin-note">Walk-ins only, according to the official restaurant listing.</p>':`<div class="contact-buttons">${onlineButton}${phoneButton}${venue.whatsapp?action(venue.whatsapp,'Message on WhatsApp','Contact the restaurant'):''}${emailButton}</div>`}<p class="reservation-note">${e(venue.reservationNote)}</p>${!walkIn && venue.emailBookingAllowed===false && venue.email?`<div class="detail-links">${sourceAnchor('mailto:'+venue.email,'General email · not bookings')}</div>`:''}</section></div>
      <aside class="place-rail" aria-label="Plan your visit"><section class="visit-panel"><h3>Plan your visit</h3><div class="visit-fact"><span class="place-eyebrow">Find it</span><address>${e(venue.address)}</address><a href="${e(googleMapsLink(venue))}" ${external}>Get directions ${icon('arrow')}</a></div><div class="visit-fact"><span class="place-eyebrow">Opening hours</span><p>${e(venue.hours || 'Hours not verified. Check with the restaurant before visiting.')}</p></div><details class="price-detail"><summary>Menu &amp; price notes</summary><p>${e(venue.priceNote || 'See the current menu for prices.')}</p></details></section></aside></div>
      <footer class="place-footer"><details class="source-details"><summary>Sources &amp; things to know</summary><p>Restaurant details checked ${e(venue.checkedAt || data.checkedAt)}. Delivery listings checked ${e(venue.deliveryCheckedAt || data.deliveryCheckedAt)}. Listings do not mean a restaurant is accepting orders right now.</p>${(venue.auditIssues || []).length?`<ul>${venue.auditIssues.map(issue=>`<li>${e(issue)}</li>`).join('')}</ul>`:''}${sources.map(check=>`<p>${check.linkStatus==='unrelated-redirect'?e('Former website withheld: '+check.source):sourceAnchor(check.source,'Source · '+check.checkedAt)}${check.note?`<small>${e(check.note)}</small>`:''}</p>`).join('')}${venue.image?`<p>${sourceAnchor(venue.imageSource,venue.imageCredit)}<small>${e(venue.imageRightsStatus || '')}</small></p>`:''}<p class="source-footnote">Independent directory. Orders and table bookings are handled by the restaurant or delivery provider.</p></details><div class="trust-links"><a href="mailto:${e(data.contactEmail)}?subject=${encodeURIComponent('Correction: '+venue.name)}">Report incorrect information</a><a href="mailto:${e(data.contactEmail)}?subject=${encodeURIComponent('Owner update: '+venue.name)}">Restaurant owner? Update this listing</a></div></footer>
      <section class="detail-section nearby-section"><h3>More in ${e(venue.area)}</h3>${venues.filter(other=>other.id!==venue.id && other.area===venue.area).slice(0,2).map(other=>`<button class="similar-place" data-action="open-place" data-id="${e(other.id)}"><span>${e(other.name)}<small> · ${e(other.cuisine)}</small></span>${icon('arrow')}</button>`).join('') || '<p>More nearby places are being researched.</p>'}</section></div></div><div class="dialog-toast" role="status" aria-live="polite">${icon('check')}<span class="dialog-toast-message"></span></div>`;
  }
  function showPlace(id, changeHash = true) {
    const venue = byId.get(id); if (!venue || closing) return;
    if (infoDialog.open) infoDialog.close();
    if (!placeDialog.open) priorDialogFocus = document.activeElement;
    currentVenue = venue;
    placeDialog.innerHTML = venueDialogHTML(venue);
    if (!placeDialog.open) placeDialog.showModal();
    document.documentElement.style.overflow = 'hidden';
    placeDialog.querySelector('.dialog-scroll').scrollTop = 0;
    if (changeHash) history.pushState({tablePlace:true},'',`/place/${encodeURIComponent(id)}/`);
    updateMetadata(venue);
    updateMessage();
    syncSaved();
  }
  function closeDialog(dialog) {
    if (!dialog.open || closing) return;
    if (dialog === placeDialog && !routeClosing) { if (history.state?.tablePlace) { history.back(); return; } history.replaceState(null,'','/'); updateMetadata(null); }
    closing = true;
    dialog.classList.add('closing');
    setTimeout(() => {
      dialog.close();
      dialog.classList.remove('closing');
      closing = false;
    }, reducedMotion.matches ? 0 : 170);
  }
  function onDialogClosed(dialog) {
    if (dialog === placeDialog) { currentVenue = null; updateMetadata(null); }
    if (!placeDialog.open && !infoDialog.open) document.documentElement.style.overflow = '';
    if (priorDialogFocus && document.contains(priorDialogFocus)) priorDialogFocus.focus({preventScroll:true});
    else if (!placeDialog.open && !infoDialog.open) $('#search-input').focus({preventScroll:true});
  }
  function infoHTML(page) {
    const sources = page === 'sources';
    const sourceEntries = venues.map(venue => `<details><summary>${escapeHTML(venue.name)}</summary>${sourceAnchor(venue.contactSource,venue.contactSourceName)}${sourceAnchor(venue.tripadvisor,'Tripadvisor review listing')}<small>${escapeHTML(venue.contactProvenance)}</small></details>`).join('');
    return `<button class="icon-button close-info" data-action="close-info" aria-label="Close guide" autofocus>${icon('close')}</button><div class="info-content"><div class="info-mark">${icon('table')}</div><h2 id="info-title">${sources ? 'A clear little directory.' : 'Find a place.<br>Make a plan.'}</h2>${sources ? `<p class="info-intro">Gib .today is an independent starting point for eating out in Gibraltar. ${venues.length} selected places across ${data.areas.length} neighbourhoods. Not a complete list, and not a paid ranking.</p><h3>What makes it into the directory?</h3><p>A Gibraltar location, published Tripadvisor reviews, and a usable digital listing or website with a way to contact or visit. We choose a spread of cuisines, neighbourhoods and meal types rather than importing every listing. Inclusion is not a quality rating, first-hand review or partnership.</p><h3>Published details, not live availability.</h3><p>Original package check: ${checkedDate}. Individual listings show their latest check date. Some entries still await a fresh full check. Opening hours and availability are not inferred. Tripadvisor scores and review counts stay on Tripadvisor, where you can read the current listing.</p><div class="source-list">${sourceEntries}</div><h3>A note on the photography</h3><p>This local preview uses venue-specific photographs from business websites, official tourism pages, editorial features and credited venue galleries. Sources are linked on each listing. Some source images are collages or archival photos; they do not establish that a venue is currently trading. Original photographer and public reuse permissions remain unconfirmed for reference-gallery images, so obtain clearance or replace them before publication. Editorial covers remain as a fallback if an image cannot load. No generated images are presented as restaurant photographs.</p><h3>Your browser. Your saved places.</h3><p>Saved places, layout and appearance are stored only in this browser. There are no accounts, tracking scripts, booking records or advertising cookies. Clearing browser data removes your saved places. External websites have their own privacy practices.</p><button class="button secondary" data-action="theme">${icon('moon')}Change appearance</button>` : `<p class="info-intro">A simpler way to find somewhere to eat in Gibraltar. No account. No booking platform in between.</p><div class="steps"><div class="step"><span class="step-number">01</span><div><h3>Find somewhere that feels right.</h3><p>Explore by neighbourhood or cuisine. Save a few possibilities for another day.</p></div></div><div class="step"><span class="step-number">02</span><div><h3>See exactly how to reserve.</h3><p>Open a place for its published phone number, reservation page or enquiry email. Places with a verified walk-in policy are clearly marked instead.</p></div></div><div class="step"><span class="step-number">03</span><div><h3>Speak to the restaurant.</h3><p>Call, visit its reservation page, or send your own enquiry. The restaurant confirms it directly; Gib .today does not. For walk-in places, check the venue’s hours and head over.</p></div></div></div><div class="info-callout">No live availability. No booking fee. Gib .today only points you to the restaurant. Opening a contact link or copying an enquiry does not reserve a table.</div><button class="text-button" data-action="info" data-page="sources">Read about the directory and its sources</button>`}<div class="info-bottom"><span>Find somewhere good.</span><span>Gib .today</span></div></div>`;
  }
  function showInfo(page) {
    if (closing) return;
    if (placeDialog.open) placeDialog.close();
    if (!infoDialog.open) priorDialogFocus = document.activeElement;
    infoDialog.innerHTML = infoHTML(page);
    if (!infoDialog.open) infoDialog.showModal();
    infoDialog.scrollTop = 0;
    $('.close-info', infoDialog).focus({preventScroll:true});
    document.documentElement.style.overflow = 'hidden';
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
    const description = venue?.description || 'Curated places to eat in Gibraltar, with the simplest way to reserve.';
    document.title = title;
    $('meta[name="description"]').content = description;
    $('meta[property="og:title"]').content = title;
    $('meta[property="og:description"]').content = description;
    const url = `https://gib.today${venue ? `/place/${venue.id}/` : '/'}`;
    $('link[rel="canonical"]').href = url; $('meta[property="og:url"]').content = url;
  }
  function handleHash() {
    const match = location.pathname.match(/^\/place\/([a-z0-9-]+)\/?$/) || location.hash.match(/^#place\/([a-z0-9-]+)$/);
    if (match && byId.has(match[1])) showPlace(match[1],false);
    else if (placeDialog.open) { routeClosing=true; closeDialog(placeDialog); routeClosing=false; }
  }
  const contactDialog = document.createElement('dialog');
  contactDialog.className = 'contact-dialog';
  contactDialog.setAttribute('aria-labelledby', 'contact-title');
  document.body.append(contactDialog);
  let contactTarget = null, contactTrigger = null, contactRequestId = null, contactPayload = null;
  function openContact(link) {
    contactTarget = new URL(link.href); contactTrigger = link; contactRequestId = (crypto.randomUUID?.() || 'forms-disabled'); contactPayload = null;
    const email = contactTarget.protocol === 'mailto:';
    const phone = contactTarget.protocol === 'tel:';
    const subject = contactTarget.searchParams.get('subject') || (currentVenue ? 'Enquiry — '+currentVenue.name : 'Contact Gib .today');
    contactDialog.innerHTML = `<form class="contact-form"><button type="button" class="icon-button contact-close" aria-label="Close contact form">${icon('close')}</button><p class="dialog-kicker">${email ? 'Email enquiry' : phone ? 'Phone enquiry' : 'WhatsApp enquiry'}</p><h2 id="contact-title">${escapeHTML(subject)}</h2><p>${email ? 'Send your message here. Replies go to the email address you provide.' : phone ? 'Add a note for your call, then open your phone app.' : 'Prepare your message, then send it in WhatsApp.'}</p><label>Your name<input name="name" autocomplete="name" required maxlength="100" placeholder="Name"></label>${email ? '<label>Your email<input name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"></label><div class="contact-honeypot" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>' : ''}<label>Message<textarea name="message" rows="5" maxlength="5000" required placeholder="How can we help?"></textarea></label><p class="contact-destination">To: ${escapeHTML(email || phone ? decodeURIComponent(contactTarget.pathname) : currentVenue?.name || 'Restaurant')}</p><button class="button primary" type="submit">${phone ? 'Continue to call' : email ? 'Send message' : 'Open WhatsApp to send'} ${icon('arrow')}</button><p class="source-footnote">${email ? 'Your name, email and message are sent to the recipient shown above. Table enquiries need restaurant confirmation.' : 'You complete the action in the next app.'}</p><p class="contact-status" role="status" aria-live="polite"></p></form>`;
    if (email && data.contactSendingEnabled === false) { const form = contactDialog.querySelector('form'); form.querySelectorAll('input,textarea,button[type=submit]').forEach(field => field.disabled=true); form.querySelector('[type=submit]').textContent='Sending temporarily unavailable'; form.querySelector('.contact-status').textContent='Online messages are temporarily unavailable. Please use the restaurant’s phone, WhatsApp or official booking page where provided.'; }
    contactDialog.querySelector('textarea').value = contactTarget.searchParams.get('body') || '';
    contactDialog.querySelector('.contact-close').onclick = () => contactDialog.close();
    contactDialog.showModal();
  }
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || contactDialog.contains(link)) return;
    if (/^(mailto:|tel:|https:\/\/wa\.me\/)/i.test(link.href)) { event.preventDefault(); openContact(link); }
  }, true);
  contactDialog.addEventListener('click', event => { if (event.target === contactDialog) { const b=contactDialog.getBoundingClientRect(); if(event.clientX<b.left || event.clientX>b.right || event.clientY<b.top || event.clientY>b.bottom) contactDialog.close(); } });
  contactDialog.addEventListener('close', () => contactTrigger?.focus());
  contactDialog.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    if (contactTarget.protocol === 'mailto:') {
      const button = form.querySelector('[type="submit"]'), status = form.querySelector('.contact-status');
      const subject = contactTarget.searchParams.get('subject') || '';
      const recipient = decodeURIComponent(contactTarget.pathname).toLowerCase();
      const venue = venues.find(v => v.email?.toLowerCase() === recipient);
      const kind = recipient !== data.contactEmail.toLowerCase() ? 'restaurant' : /correction/i.test(subject) ? 'correction' : /owner|listing update/i.test(subject) ? 'owner' : /suggest/i.test(subject) ? 'suggestion' : 'general';
      const payload = {name:form.elements.name.value.trim(), email:form.elements.email.value.trim(), message:form.elements.message.value.trim(), website:form.elements.website.value, kind, venueId:kind === 'restaurant' ? venue?.id : placeDialog.open ? currentVenue?.id : null};
      const serialized = JSON.stringify(payload);
      if (contactPayload !== null && contactPayload !== serialized) contactRequestId = (crypto.randomUUID?.() || 'forms-disabled');
      contactPayload = serialized;
      button.disabled = true; button.textContent = 'Sending…'; status.textContent = '';
      try {
        const response = await fetch('/api/contact', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,requestId:contactRequestId})});
        const result = await response.json();
        if (!response.ok || !result.accepted) throw new Error(result.error || 'Your message could not be sent. Please retry.');
        status.textContent = 'Message sent. Replies will go to your email address.';
        button.textContent = 'Sent';
        form.querySelectorAll('input,textarea').forEach(field => { field.disabled=true; });
      } catch (error) {
        status.textContent = error instanceof SyntaxError ? 'Sending is unavailable. Your message is kept here; please retry.' : error.message;
        button.disabled=false; button.textContent='Retry sending';
      }
      return;
    }
    const message = form.elements.message.value.trim()+'\n\n'+form.elements.name.value.trim();
    const url = new URL(contactTarget.href);
    if (url.hostname === 'wa.me') url.searchParams.set('text',message);
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
      case 'clear-collection': state.collection='all'; render(); break;
      case 'cuisine': animateUpdate(()=>{ state.cuisine = button.dataset.cuisine; render(); }); break;
      case 'layout': animateUpdate(()=>{ state.layout = button.dataset.layout; storage.set('layout',state.layout); render(); }); break;
      case 'save': toggleSaved(button.dataset.id, button); break;
      case 'open-place': showPlace(button.dataset.id); break;
      case 'close-place': closeDialog(placeDialog); break;
      case 'close-info': closeDialog(infoDialog); break;
      case 'info': showInfo(button.dataset.page); break;
      case 'theme': animateUpdate(setTheme); break;
      case 'focus-search': $('#search-input').focus(); break;
      case 'clear-search': clearTimeout(searchTimeout); state.query = ''; $('#search-input').value=''; render(); $('#search-input').focus(); break;
      case 'reset-filters': animateUpdate(resetFilters); break;
      case 'clear-cuisine': state.cuisine='all'; render(); break;
      case 'clear-area': state.area='all'; render(); break;
      case 'delivery': state.delivery=button.dataset.delivery; animateUpdate(render); break;
      case 'clear-delivery': state.delivery='all'; animateUpdate(render); break;
      case 'clear-online': state.online=false; render(); break;
      case 'toggle-filters': { const open = $('#filter-panel').hidden; $('#filter-panel').hidden = !open; button.setAttribute('aria-expanded',String(open)); break; }
      case 'copy-phone': if (currentVenue) copyText(currentVenue.phone,'Phone number copied'); break;
      case 'copy-message': if ($('#message-preview')) copyText($('#message-preview').value,'Enquiry copied. Nothing has been sent.'); break;
      case 'share-place': if (currentVenue) {
        if (location.protocol === 'file:') { copyText(currentVenue.tripadvisor,'Tripadvisor link copied'); }
        else copyText(new URL(`/place/${currentVenue.id}/`,location.href).href,'Place link copied');
      } break;
    }
  });
  $('#search-input').addEventListener('input',event => { state.query = event.target.value; clearTimeout(searchTimeout); searchTimeout = setTimeout(render,65); });
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
      if (placeDialog.open||infoDialog.open) return;
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
  render(); syncTheme(); handleHash();
})();

