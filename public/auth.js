(()=>{const original=window.fetch.bind(window);window.fetch=async(...args)=>{const r=await original(...args);if(r.status===401)location.replace('/login');return r;};
  let expiry=0;function lock(){if(expiry&&Date.now()>=expiry)location.replace('/login');}
  original('/api/auth/session').then(async r=>{if(!r.ok){location.replace('/login');return;}const user=await r.json();expiry=user.expires;setTimeout(lock,Math.max(0,expiry-Date.now()));const addLock=()=>{const button=document.createElement('button');button.textContent='Hello, '+user.name+' · Lock';button.addEventListener('click',async()=>{await original('/api/auth/logout',{method:'POST',headers:{'X-Mir-Request':'dashboard'}});location.replace('/login');});document.querySelector('header')?.append(button);};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',addLock);else addLock();});
  document.addEventListener('visibilitychange',lock);window.addEventListener('focus',lock);
})();
