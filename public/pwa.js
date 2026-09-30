(() => {
  "use strict";

  const MANIFEST = "/manifest.webmanifest";

  function ensureMeta() {
    if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = MANIFEST;
      document.head.appendChild(link);
    }
    if (!document.querySelector('meta[name="theme-color"]')) {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.content = "#07131f";
      document.head.appendChild(meta);
    }
    if (!document.querySelector('meta[name="mobile-web-app-capable"]')) {
      const meta = document.createElement("meta");
      meta.name = "mobile-web-app-capable";
      meta.content = "yes";
      document.head.appendChild(meta);
    }
    if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
      const meta = document.createElement("meta");
      meta.name = "apple-mobile-web-app-capable";
      meta.content = "yes";
      document.head.appendChild(meta);
    }
  }

  function installNav() {
    if (/\/(login|register|forgot-password|reset-password)\.html$/i.test(location.pathname)) return;
    if (document.querySelector(".bottom-nav")) return;
    const path = location.pathname.toLowerCase();
    const items = [
      ["/dashboard.html","⌂","Home"],
      ["/data.html","▦","Data"],
      ["/wallet.html","₵","Wallet"],
      ["/orders.html","▤","Orders"],
      ["/account.html","◉","Account"]
    ];
    const nav = document.createElement("nav");
    nav.className = "dgm-pwa-nav";
    nav.setAttribute("aria-label","DGM navigation");
    nav.innerHTML = items.map(([href,icon,label]) => {
      const active = path === href || (path === "/" && href === "/dashboard.html");
      return '<a href="'+href+'"'+(active?' aria-current="page"':'')+'><span>'+icon+'</span><small>'+label+'</small></a>';
    }).join("");
    const style = document.createElement("style");
    style.textContent = `
      .dgm-pwa-nav{position:fixed;left:0;right:0;bottom:0;height:68px;z-index:9998;display:flex;align-items:center;justify-content:space-around;padding-bottom:env(safe-area-inset-bottom);background:rgba(6,15,22,.97);border-top:1px solid rgba(255,255,255,.08);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
      .dgm-pwa-nav a{flex:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;color:#80919b;text-decoration:none;font:700 10px system-ui,sans-serif}
      .dgm-pwa-nav a[aria-current="page"]{color:#20d889}
      .dgm-pwa-nav a span{font-size:20px;line-height:1}
      .dgm-pwa-nav a small{font-size:10px}
      body{padding-bottom:max(78px,calc(68px + env(safe-area-inset-bottom)))}
    `;
    document.head.appendChild(style);
    document.body.appendChild(nav);
  }

  function installPrompt() {
    let deferredPrompt = null;
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      deferredPrompt = event;
      if (window.matchMedia("(display-mode: standalone)").matches || document.getElementById("dgm-install-card")) return;

      const card = document.createElement("div");
      card.id = "dgm-install-card";
      card.innerHTML = '<div><strong>Install DGM</strong><span>Use DHE GENIUS MEDIA like an app while staying connected to the live website.</span></div><button id="dgm-install">Install</button><button id="dgm-install-close" aria-label="Close">×</button>';
      Object.assign(card.style,{position:"fixed",left:"12px",right:"12px",bottom:"78px",zIndex:"9999",display:"flex",alignItems:"center",gap:"10px",padding:"13px 14px",borderRadius:"18px",background:"rgba(7,19,31,.98)",border:"1px solid rgba(32,216,137,.25)",boxShadow:"0 16px 40px rgba(0,0,0,.35)",color:"#fff",font:"13px system-ui,sans-serif"});
      card.firstElementChild.style.flex="1";
      card.firstElementChild.lastElementChild.style.display="block";
      card.firstElementChild.lastElementChild.style.color="#8da5b8";
      card.firstElementChild.lastElementChild.style.fontSize="10px";
      const install=card.querySelector("#dgm-install");
      Object.assign(install.style,{border:0,borderRadius:"11px",padding:"10px 13px",background:"#20d889",color:"#03140b",fontWeight:"800"});
      const close=card.querySelector("#dgm-install-close");
      Object.assign(close.style,{border:0,background:"transparent",color:"#8da5b8",fontSize:"22px"});
      install.onclick=async()=>{deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;card.remove();};
      close.onclick=()=>card.remove();
      document.body.appendChild(card);
    });
    window.addEventListener("appinstalled",()=>{deferredPrompt=null;document.getElementById("dgm-install-card")?.remove();});
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js",{scope:"/"}).then(reg=>{
      reg.update().catch(()=>{});
      reg.addEventListener("updatefound",()=>{
        const worker=reg.installing;
        if (!worker) return;
        worker.addEventListener("statechange",()=>{
          if(worker.state==="installed" && navigator.serviceWorker.controller){
            window.dispatchEvent(new CustomEvent("dgm-update-ready"));
          }
        });
      });
    }).catch(()=>{});
  }

  function init() {
    ensureMeta();
    installNav();
    installPrompt();
    registerServiceWorker();
  }

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",init);
  else init();
})();