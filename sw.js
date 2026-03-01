self.addEventListener('push', function(event) {
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
                }
            };
            
            event.waitUntil(self.registration.showNotification(title, options));
        } catch (e) {
            // S'il n'y a pas de JSON, on affiche le texte brut
            event.waitUntil(self.registration.showNotification('ChessMate', {
                body: event.data.text(),
                icon: '/images/logo.png'
            }));
        }
    }
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            const urlToOpen = new URL(event.notification.data.url, self.location.origin).href;
            
            // Si une page de l'app est déjà ouverte, on la focus
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if (client.url === urlToOpen && 'focus' in client) {
                    return client.focus();
                }
            }
            // Sinon, on ouvre une nouvelle fenêtre/onglet
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
    );
});
