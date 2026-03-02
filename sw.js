// Service Worker for ChessMate Push Notifications
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
    if (!event.data) return;

    // On utilise une promesse globale pour event.waitUntil
    const promiseChain = clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clientList => {
            // Vérification de la visibilité : si au moins un client est visible, on ne montre rien
            const isAppOpenAndVisible = clientList.some(client => client.visibilityState === 'visible');

            if (isAppOpenAndVisible) {
                console.log('[SW] App visible, on ignore la notification.');
                return;
            }

            // Si on arrive ici, l'app est soit fermée (clientList vide), soit en arrière-plan
            let data;
            try {
                data = event.data.json();
            } catch (e) {
                data = { title: 'ChessMate', message: event.data.text() };
            }

            const title = data.title || 'Nouvelle notification !';
            const options = {
                body: data.message || 'Invitation reçue.',
                icon: 'images/logo.png',
                badge: 'images/logo.png',
                data: {
                    url: data.url || self.registration.scope
                },
                tag: 'duo-invite',
                renotify: true,
                vibrate: [200, 100, 200],
                actions: [{ action: 'open', title: 'Rejoindre' }]
            };

            return self.registration.showNotification(title, options);
        })
        .catch(err => {
            console.error('[SW] Erreur lors du traitement du push:', err);
            // En cas d'erreur critique, on montre quand même une notification par sécurité
            return self.registration.showNotification('ChessMate', {
                body: event.data.text(),
                icon: 'images/logo.png'
            });
        });

    event.waitUntil(promiseChain);
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
