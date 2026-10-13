import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
export async function createAccess(root){
  const folder=path.join(root,'data','access');await mkdir(folder,{recursive:true});let users;
  try{users=JSON.parse(await readFile(path.join(folder,'users.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;
    const used=new Set(),credentials=[];users=['Bayel','Tatyana','Emin','Fatima'].map(name=>{let pin;do{pin=String(randomBytes(4).readUInt32BE()%10000).padStart(4,'0');}while(used.has(pin));used.add(pin);const salt=randomBytes(16).toString('hex');credentials.push(name+': '+pin);return {name,salt,hash:scryptSync(pin,salt,32).toString('hex')};});
    await writeFile(path.join(folder,'users.json'),JSON.stringify(users),{flag:'wx'});await writeFile(path.join(folder,'initial-pins.txt'),credentials.join('\n'),{flag:'wx'});
  }
  const sessions=new Map(),attempts=new Map(),duration=15*60*1000;
  const token=req=>{const match=/(?:^|;\s*)mir_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'');return match?.[1];};
  return {
    names:users.map(u=>u.name),
    session(req){const t=token(req),s=sessions.get(t);if(!s||s.expires<=Date.now()){sessions.delete(t);return null;}return {name:s.name,expires:s.expires};},
    touch(req){const identity=this.session(req);if(!identity)return null;const t=token(req),s=sessions.get(t);s.expires=Date.now()+duration;return {session:{name:s.name,expires:s.expires},cookie:`mir_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`};},
    login(req,name,pin){const key=req.socket.remoteAddress;let a=attempts.get(key);if(!a||Date.now()-a.at>900000){a={at:Date.now(),count:0};attempts.set(key,a);}if(a.count>=8)throw Object.assign(Error('Too many attempts. Try again in 15 minutes.'),{status:429});a.count++;
      const validPin=typeof pin==='string'&&/^\d{4}$/.test(pin);let user;for(const candidate of users){const matches=timingSafeEqual(scryptSync(validPin?pin:'invalid',candidate.salt,32),Buffer.from(candidate.hash,'hex'));if(validPin&&matches)user=candidate;}if(!user)throw Object.assign(Error('Incorrect name or PIN.'),{status:401});
      attempts.delete(key);sessions.delete(token(req));for(const [t,s] of sessions)if(s.expires<=Date.now())sessions.delete(t);const t=randomBytes(32).toString('hex'),s={name:user.name,expires:Date.now()+duration};sessions.set(t,s);return {session:s,cookie:`mir_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`};
    },
    logout(req){sessions.delete(token(req));return 'mir_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';}
  };
}
