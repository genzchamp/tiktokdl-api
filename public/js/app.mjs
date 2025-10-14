// public/js/app.mjs — full replacement
// Self-contained frontend for TikTokDL (works with backend POST /api/download and GET /stream)

(function () {
  // DOM refs
  const app = document.getElementById('app');
  const form = document.getElementById('form');
  const content = document.getElementById('content');
  const submitBtn = form.querySelector('input[type="submit"]');

  // Helper: show spinner (uses your existing spinner image)
  function showLoading() {
    content.innerHTML = '<img src="./img/spinning-circles.svg" alt="loader" style="width:48px;height:48px" />';
  }

  // Helper: show error message
  function showError(msg) {
    content.innerHTML = `<h3 class="messageError">${escapeHtml(msg)}</h3>`;
  }

  // Escape HTML for debug output
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Render raw JSON (for debugging)
  function showRaw(obj) {
    content.innerHTML = `<pre style="white-space:pre-wrap; max-height:420px; overflow:auto; color:#ddd; background:#071025; padding:12px; border-radius:8px;">${escapeHtml(JSON.stringify(obj, null, 2))}</pre>`;
  }

  // Ensure compact preview area exists under the form
  function ensureCompactPreview() {
    let cp = document.getElementById('compactPreview');
    if (!cp) {
      cp = document.createElement('div');
      cp.id = 'compactPreview';
      cp.style.margin = '12px 0';
      // insert right after the form
      form.insertAdjacentElement('afterend', cp);
    }
    return cp;
  }

  // Show the download button + optional thumbnail (safe option - user clicks)
  function showDownloadLink(downloadUrl, thumbUrl) {
    // render in both content area (main) and compact preview (under input)
    content.innerHTML = ''; // clear main content
    const cp = ensureCompactPreview();
    cp.innerHTML = '';

    // thumbnail
    if (thumbUrl) {
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.alt = 'thumb';
      img.style.width = '160px';
      img.style.height = '90px';
      img.style.objectFit = 'cover';
      img.style.borderRadius = '8px';
      img.style.marginRight = '12px';
      img.style.verticalAlign = 'middle';
      cp.appendChild(img);
    }

    // same-origin stream URL (backend must implement /stream?url=...)
    const streamUrl = `/stream?url=${encodeURIComponent(downloadUrl)}`;

    // download button (user click)
    const btn = document.createElement('a');
    btn.href = streamUrl;
    btn.className = 'download-link';
    btn.textContent = '⬇ Download Video';
    btn.style.display = 'inline-block';
    btn.style.padding = '10px 14px';
    btn.style.borderRadius = '10px';
    btn.style.marginLeft = '8px';
    btn.style.fontWeight = '700';
    btn.style.textDecoration = 'none';
    btn.style.background = 'linear-gradient(90deg,#6be3ff,#ff3cac)';
    btn.style.color = '#04121a';
    btn.setAttribute('download', 'tiktok_video.mp4');
    btn.setAttribute('rel', 'noopener');

    cp.appendChild(btn);

    // backup open-in-new-tab link (direct provider URL)
    const openLink = document.createElement('a');
    openLink.href = downloadUrl;
    openLink.textContent = 'Open MP4 (new tab)';
    openLink.target = '_blank';
    openLink.rel = 'noopener';
    openLink.style.marginLeft = '10px';
    openLink.style.color = '#9fdcff';
    cp.appendChild(openLink);

    // also show a short success message in the main content area
    content.innerHTML = '<div style="padding:10px;background:rgba(255,255,255,0.02);border-radius:8px;">Ready — click the Download button below.</div>';
  }

  // Validate domain is tiktok-based
  function isTikTokDomain(url) {
    try {
      const host = new URL(url).host;
      return host.includes('tiktok.com') || host.includes('vm.tiktok.com') || host.includes('vt.tiktok.com');
    } catch (e) {
      return false;
    }
  }

  // Main submit handler
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // clear previous compact preview (so old buttons don't linger)
    const oldCP = document.getElementById('compactPreview');
    if (oldCP) oldCP.innerHTML = '';

    const formUrl = e.target.url.value && e.target.url.value.trim();
    if (!formUrl) {
      showError('Please paste a TikTok link.');
      return;
    }

    if (!isTikTokDomain(formUrl)) {
      showError('Error: The URL is not a TikTok link.');
      e.target.reset();
      return;
    }

    // UI lock
    submitBtn.disabled = true;
    submitBtn.value = 'Processing…';
    showLoading();

    try {
      const resp = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiktokUrl: formUrl })
      });

      const rawText = await resp.text();
      // try parse JSON
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (err) {
        // server returned non-JSON (HTML / error page)
        showRaw({ error: 'Non-JSON response from server', raw: rawText });
        return;
      }

      if (!resp.ok) {
        // show server-provided JSON (should include raw for debugging)
        showRaw(data);
        return;
      }

      // success — normalized backend returns { ok:true, downloadUrl, thumbnail, raw }
      const downloadUrl = data.downloadUrl || data.url || (data.video && typeof data.video === 'string' ? data.video : null) || data.video?.url || data.video?.playAddr || null;
      const thumbnail = data.thumbnail || data.thumb || (data.video && data.video.thumbnail) || null;

      if (!downloadUrl) {
        // backend didn't find a downloadable URL — show raw result to debug
        showRaw({ error: 'No download URL found in response', raw: data.raw || data });
        return;
      }

      // render download button + preview (safe: user clicks)
      showDownloadLink(downloadUrl, thumbnail);
    } catch (err) {
      console.error('Fetch error', err);
      showError('Network or server error. Try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.value = 'GENERATE';
      e.target.reset();
    }
  });

  // initialize small UX: clear compact preview on page load
  const cpInit = document.getElementById('compactPreview');
  if (cpInit) cpInit.innerHTML = '';
})();
