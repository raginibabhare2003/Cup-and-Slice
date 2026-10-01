const CACHE='cup-slice-v4';
const ASSETS=['/','/index.html','/dashboard.html','/admin.html','/setup.html','/style1.css','/script.js','/manifest.json','/icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))));});

self.addEventListener('push',event=>{let data={title:'Cup & Slice',message:'You have a new notification.',url:'/dashboard.html'};try{if(event.data)data=event.data.json()}catch{}event.waitUntil(self.registration.showNotification(data.title,{body:data.message,icon:'/icon.svg',badge:'/icon.svg',data:{url:data.url||'/dashboard.html'}}))});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if('focus'in c){c.navigate(event.notification.data?.url||'/dashboard.html');return c.focus()}}return clients.openWindow(event.notification.data?.url||'/dashboard.html')}))});
