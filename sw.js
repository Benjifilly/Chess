// Service Worker for ChessMate Push Notifications
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
    if (event.data) {
        event.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
                // Vérifier si au moins un onglet/fenêtre de l'app est au premier plan
                const isAppVisible = clientList.some(client => {
                    const isSameApp = client.url.indexOf(self.registration.scope) !== -1;
                    return isSameApp && client.visibilityState === 'visible' && client.focused;
                });


                if (isAppVisible) {
                    return;
                }

                try {
                    const data = event.data.json();
                    const title = data.title || 'ChessMate';
                    const options = {
                        body: data.message || 'Nouvelle notification',
                        icon: 'images/logo.png',
                        badge: 'images/logo.png',
                        data: {
                            url: data.url || self.registration.scope
                        },
                        vibrate: [200, 100, 200],
                        tag: 'duo-invite',
                        renotify: true,
                        actions: [
                            { action: 'open', title: 'Rejoindre' }
                        ]
                    };
                    
                    return self.registration.showNotification(title, options);
                } catch (e) {
                    return self.registration.showNotification('ChessMate', {
                        body: event.data.text(),
                        icon: 'images/logo.png',
                        data: { url: self.registration.scope }
                    });
                }
            })
        );
    }
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    
    let targetUrl = self.registration.scope;
    if (event.notification.data && event.notification.data.url) {
        targetUrl = event.notification.data.url;
    }

    const url = new URL(targetUrl, self.registration.scope);
    url.searchParams.set('from', 'push');
    const fullTargetUrl = url.href;

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if (client.url.startsWith(self.registration.scope) && 'focus' in client) {

                    if ('navigate' in client) {
                        client.navigate(fullTargetUrl);
                    }
                    return client.focus();
                }
            }
            
            if (clients.openWindow) {
                return clients.openWindow(fullTargetUrl);
            }
        })
    );
});
