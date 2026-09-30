(() => {
  "use strict";
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js", {scope:"/"}).catch(() => {}));
  }

  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredPrompt = event;
    showInstall();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    document.getElementById("dgm-install-card")?.remove();
  });

  function showInstall() {
    if (window.matchMedia("(display-mode: standalone)").matches || document.getElementById("dgm-install-card")) return;
    const card = document.createElement("div");
    card.id = "dgm-install-card";
    card.innerHTML = '<div><strong>Install DGM</strong><span>Use DHE GENIUS MEDIA like an app — the live website stays connected.</span></div><button id="dgm-install">Install</button><button id="dgm-install-close" aria-label="Close">×</button>';
    Object.assign(card.style,{position:"fixed",left:"12px",right:"12px",bottom:"82px",zIndex:"9999",display:"flex",alignItems:"center",gap:"10px",padding:"13px 14px",borderRadius:"18px",background:"rgba(7,19,31,.97)",border:"1px solid rgba(32,216,137,.25)",boxShadow:"0 16px 40px rgba(0,0,0,.35)",color:"#fff",font:"13px system-ui,sans-serif"});
    card.firstElementChild.style.flex="1";
    card.firstElementChild.lastElementChild.style.display="block";
    card.firstElementChild.lastElementChild.style.color="#8da5b8";
    card.firstElementChild.lastElementChild.style.fontSize="10px";
    const install=card.querySelector("#dgm-install");
    Object.assign(install.style,{border:0,borderRadius:"11px",padding:"10px 13px",background:"#20d889",color:"#03140b",fontWeight:"800"});
    const close=card.querySelector("#dgm-install-close");
    Object.assign(close.style,{border:0,background:"transparent",color:"#8da5b8",fontSize:"22px"});
    install.onclick=async()=>{ if(!deferredPrompt)return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; card.remove(); };
    close.onclick=()=>card.remove();
    document.body.appendChild(card);
  }
})();