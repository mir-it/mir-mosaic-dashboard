(()=>{
 const original=window.fetch.bind(window);let expiry=0,timer=null,pending=null,lastSent=0,renewing=false,dirty=false;
 const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('mir-session-activity'):null;
 const redirect=()=>location.replace('/login');
 window.fetch=async(...args)=>{const r=await original(...args);if(r.status===401)redirect();return r;};
 function schedule(expires){expiry=expires;clearTimeout(timer);timer=setTimeout(check,Math.max(0,expiry-Date.now()));}
 async function check(){try{const r=await original('/api/auth/session');if(!r.ok){redirect();return;}const user=await r.json();if(user.expires<=Date.now()){redirect();return;}schedule(user.expires);}catch{if(expiry&&Date.now()>=expiry){redirect();return;}clearTimeout(timer);timer=setTimeout(check,2000);}}
 async function renew(){pending=null;if(renewing){dirty=true;return;}renewing=true;dirty=false;lastSent=Date.now();try{const r=await original('/api/auth/activity',{method:'POST',headers:{'X-Mir-Request':'dashboard'}});if(!r.ok){if(r.status===401)redirect();return;}const user=await r.json();schedule(user.expires);channel?.postMessage({expires:user.expires});}catch{}finally{renewing=false;if(dirty&&!pending)pending=setTimeout(renew,30000);}}
 function activity(event){if(!event.isTrusted)return;dirty=true;if(Date.now()-lastSent>=30000||expiry-Date.now()<60000){clearTimeout(pending);void renew();}else if(!pending)pending=setTimeout(renew,Math.max(0,30000-(Date.now()-lastSent)));}
 for(const event of ['pointerdown','keydown','wheel','touchstart','scroll'])document.addEventListener(event,activity,{passive:true,capture:true});
 channel?.addEventListener('message',event=>{if(event.data?.locked)redirect();else if(Number.isFinite(event.data?.expires)&&event.data.expires>expiry)schedule(event.data.expires);});
 original('/api/auth/session').then(async r=>{if(!r.ok){redirect();return;}const user=await r.json();schedule(user.expires);const addLock=()=>{const button=document.createElement('button');button.textContent='Hello, '+user.name+' · Lock';button.addEventListener('click',async()=>{clearTimeout(pending);await original('/api/auth/logout',{method:'POST',headers:{'X-Mir-Request':'dashboard'}});channel?.postMessage({locked:true});redirect();});document.querySelector('header')?.append(button);};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',addLock);else addLock();}).catch(()=>{timer=setTimeout(check,2000);});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check();});window.addEventListener('focus',()=>{void check();});
})();
