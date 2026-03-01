// Service Worker for ChessMate Push Notifications
self.addEventListener('install', (event) => {
    self.skipWaiting();
    console.log('Service Worker: Installed');
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
    console.log('Service Worker: Activated');
});

self.addEventListener('push', function(event) {
    console.log('Service Worker: Push reçu', event);
    if (event.data) {
        try {
            const data = event.data.json();
            const title = data.title || 'ChessMate';
            const options = {
                body: data.message || 'Nouvelle notification',
                icon: data.icon || '/images/logo.png',
                badge: data.badge || '/images/logo.png',
                data: {
                    url: data.url || '/'
                },
                vibrate: [100, 50, 100],
                actions: [
                    { action: 'open', title: 'Voir la partie' }
                ]
            };
            
            event.waitUntil(self.registration.showNotification(title, options));
        } catch (e) {
            console.log('Service Worker: Push data non-JSON', event.data.text());
            event.waitUntil(self.registration.showNotification('ChessMate', {
                body: event.data.text(),
                icon: '/images/logo.png'
            }));
        }
    }
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    
    let targetUrl = '/';
    if (event.notification.data && event.notification.data.url) {
        targetUrl = event.notification.data.url;
    }

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            const fullTargetUrl = new URL(targetUrl, self.location.origin).href;
            
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if (client.url === fullTargetUrl && 'focus' in client) {
                    return client.focus();
                }
            }
            
            if (clients.openWindow) {
                return clients.openWindow(fullTargetUrl);
            }
        })
    );
});
