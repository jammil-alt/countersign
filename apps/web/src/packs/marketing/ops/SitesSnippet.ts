// The snippet a site owner pastes into every page of a measured site (M44, docs/marketing-plan.md
// §4.3): one small inline script that reports to the platform's inbound route,
// `<app origin>/api/in/marketing/<client id>/<site id>` (the pack's collector, which checks the
// page's origin is the site's domain and answers 204 to everything).
//
// What it reports, as the collector reads it (packs/marketing src/measure/events.ts `parseBeacon`):
// a view (path, the address's query for its campaign tags, the referrer), time engaged and how
// far down in quarters (sent when the page is hidden or left), a click on an element marked
// `data-track="name"` with where it sits on the page, and an element marked
// `data-track-form="name"` coming into sight. It sets no cookie and stores nothing in the browser.
// Global Privacy Control, Do Not Track, or `localStorage["mezonas-measure"] = "off"` (an opt-out
// page sets it) and it reports nothing at all. Every failure is swallowed: it never breaks a page.
//
// Sent as text (`sendBeacon` with a string, or a no-cors `fetch`), which a browser sends across
// origins without asking first. Ported from Plenary Labs' `apps/site/public/track.js` (copied).

// DECISION (docs/plan.md §1.74): beacons go to the app's own origin until the collector's own host
// (`collect.mezonas.com`) has its PR; the screen passes `window.location.origin`.
/** The address a site's beacons go to. */
export function beaconUrl(origin: string, clientId: string, siteId: string): string {
  return `${origin.replace(/\/+$/, "")}/api/in/marketing/${clientId}/${siteId}`;
}

const SCRIPT = `(function(){
var E=__ENDPOINT__;
if(navigator.globalPrivacyControl===true||navigator.doNotTrack==="1")return;
try{if(localStorage.getItem("mezonas-measure")==="off")return}catch(e){}
function uid(){if(crypto.randomUUID)return crypto.randomUUID();var b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h=Array.from(b,function(x){return(x+256).toString(16).slice(1)}).join("");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}
function send(ev){try{var body=JSON.stringify({events:ev});if(navigator.sendBeacon&&navigator.sendBeacon(E,body))return;fetch(E,{method:"POST",body:body,keepalive:true,mode:"no-cors"}).catch(function(){})}catch(e){}}
var p=location.pathname.slice(0,512),v=uid(),ms=0,act=Date.now(),last=Date.now(),reach=0,sent=0,once=false;
function quarter(){var h=document.documentElement.scrollHeight;if(!(h>0))return 0;return Math.max(0,Math.min(4,Math.floor(Math.min(1,(scrollY+innerHeight)/h)*4+1e-4)))}
function tick(){var n=Date.now();if(document.visibilityState==="visible"&&n-act<30000)ms+=Math.min(n-last,5000);last=n}
["keydown","pointerdown","pointermove","scroll","touchstart","wheel"].forEach(function(k){addEventListener(k,function(){tick();act=Date.now()},{passive:true,capture:true})});
addEventListener("scroll",function(){reach=Math.max(reach,quarter())},{passive:true});
setInterval(tick,1000);
function engage(){tick();reach=Math.max(reach,quarter());var m=Math.min(Math.round(ms),3600000);if(once&&m===0&&reach===sent)return;send([{k:"engage",id:v,p:p,ms:m,s:reach}]);ms=0;sent=reach;once=true}
function view(){var e={k:"view",id:v,p:p,q:location.search.slice(0,2048),r:document.referrer.slice(0,2048)};if(navigator.webdriver===true)e.wd=true;send([e])}
document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")engage();else{last=act=Date.now()}});
addEventListener("pagehide",engage);
addEventListener("pageshow",function(e){if(!e.persisted)return;v=uid();ms=0;once=false;reach=sent=quarter();last=act=Date.now();view()});
document.addEventListener("click",function(e){var t=e.target&&e.target.closest?e.target.closest("[data-track]"):null;var n=t&&t.getAttribute("data-track");if(!n)return;var h=document.documentElement.scrollHeight||1;send([{k:"click",id:v,p:p,n:n,y:Math.max(0,Math.min(100,Math.round((t.getBoundingClientRect().top+scrollY)/h*100)))}])},{capture:true});
if("IntersectionObserver" in window){var seen={},o=new IntersectionObserver(function(es){es.forEach(function(x){var f=(x.target.getAttribute("data-track-form")||"form").slice(0,40);if(!x.isIntersecting||seen[f])return;seen[f]=1;send([{k:"form_seen",id:v,p:p,f:f}]);o.unobserve(x.target)})},{threshold:0.5});document.querySelectorAll("[data-track-form]").forEach(function(t){o.observe(t)})}
reach=sent=quarter();view();
})();`;

/**
 * The snippet for one site: a `<script>` tag with the code inline, to paste before `</body>` on
 * every page. The address is written as a JSON string with `<` escaped, so nothing in it can
 * close the tag.
 */
export function siteSnippet(input: { origin: string; clientId: string; siteId: string }): string {
  const endpoint = JSON.stringify(beaconUrl(input.origin, input.clientId, input.siteId)).replace(
    /</g,
    "\\u003c",
  );
  return `<!-- Mezonas: measures this site without cookies -->\n<script>\n${SCRIPT.replace("__ENDPOINT__", endpoint)}\n</script>`;
}
