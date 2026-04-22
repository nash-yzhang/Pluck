// Apply i18n strings from saved language preference
chrome.storage.sync.get('cwaLanguage', function(r) {
  var t = cwaT(r.cwaLanguage || 'en');
  document.getElementById('menu-settings-text').textContent = t.menuSettings;
  document.getElementById('menu-capture-text').textContent  = t.menuCapture;
  document.getElementById('menu-toggle-text').textContent   = t.menuToggle;
});

document.getElementById('item-settings').addEventListener('click', function() {
  chrome.runtime.openOptionsPage();
  window.close();
});

document.getElementById('item-capture').addEventListener('click', function() {
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (!tabs[0]) return;
    chrome.sidePanel.open({ tabId: tabs[0].id }).then(function() {
      chrome.storage.session.set({ cwaGoCapture: { t: Date.now(), url: tabs[0].url || '' } });
    }).catch(function() {});
  });
  window.close();
});

// Toggle: called directly in popup (user-gesture context) so sidePanel.open() is allowed.
document.getElementById('item-toggle').addEventListener('click', function() {
  chrome.storage.session.get('cwaSpOpen', function(data) {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs[0]) return;
      if (data.cwaSpOpen) {
        chrome.windows.getCurrent(function(w) {
          chrome.sidePanel.close({ windowId: w.id }).catch(function() {});
          chrome.storage.session.set({ cwaSpOpen: false });
        });
      } else {
        chrome.sidePanel.open({ tabId: tabs[0].id }).catch(function() {});
      }
    });
  });
  window.close();
});
