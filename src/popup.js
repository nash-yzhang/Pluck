// Apply i18n strings from saved language preference
chrome.storage.sync.get('cwaLanguage', function(r) {
  var t = cwaT(r.cwaLanguage || 'en');
  document.getElementById('menu-settings-text').textContent = t.menuSettings;
  document.getElementById('menu-capture-text').textContent  = t.menuCapture;
  document.getElementById('menu-toggle-text').textContent   = t.menuToggle;
  document.getElementById('menu-update-text').textContent   = t.menuUpdate || 'Check Update';
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

document.getElementById('item-update').addEventListener('click', function() {
  chrome.storage.sync.get(['cwaLanguage'], function(r) {
    var t = cwaT(r.cwaLanguage || 'en');
    chrome.runtime.sendMessage({
      type: 'CHECK_RELEASE_UPDATE',
      payload: { prefix: 'RELEASE' },
    }, function(resp) {
      if (chrome.runtime.lastError) {
        alert((t.updateFailedPfx || 'Update check failed: ') + chrome.runtime.lastError.message);
        window.close();
        return;
      }
      if (!resp || resp.error) {
        alert((t.updateFailedPfx || 'Update check failed: ') + ((resp && resp.error) || 'unknown error'));
        window.close();
        return;
      }
      if (!resp.updateAvailable) {
        alert((t.updateLatest || 'Already latest RELEASE commit.') + '\n' + (resp.latest && resp.latest.shaShort ? resp.latest.shaShort : ''));
        window.close();
        return;
      }
      var yes = confirm(
        (t.updateConfirmNow || 'Update found. Apply now?') + '\n' +
        (resp.latest.message || '') + '\n' +
        (resp.latest.shaShort || '')
      );
      if (!yes) {
        window.close();
        return;
      }
      alert(
        (t.updateFound || 'New RELEASE commit found.') + '\n' +
        (resp.latest.message || '') + '\n' +
        (resp.latest.shaShort || '') + '\n\n' +
        'Run in local repo:\n' + (resp.suggestedCommand || '')
      );
      window.close();
    });
  });
});
