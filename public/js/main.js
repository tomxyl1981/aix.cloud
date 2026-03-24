const API_BASE = '';

async function api(endpoint, options = {}) {
  const token = localStorage.getItem('token');
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `aix-cloud ${token}` } : {}),
      ...options.headers
    }
  });
  return res.json();
}

async function loadFeaturedModels() {
  try {
    const data = await api('/v1/models');
    const models = data.data || [];
    
    const featured = models.slice(0, 6);
    const container = document.getElementById('featured-models');
    
    if (!container) return;
    
    container.innerHTML = featured.map(m => `
      <div class="col-md-4 col-sm-6">
        <div class="model-card h-100">
          <div class="model-header">
            <div class="model-icon">${m.id.charAt(0).toUpperCase()}</div>
            <div>
              <p class="model-name">${m.display_name || m.id}</p>
              <p class="model-provider">${m.architecture?.modality || 'text'}</p>
            </div>
          </div>
          <div class="model-price mt-auto">
            <span>输入: $${parseFloat(m.pricing?.prompt || 0).toFixed(2)}/1K</span>
            <span>输出: $${parseFloat(m.pricing?.completion || 0).toFixed(2)}/1K</span>
          </div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error('Failed to load models:', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadFeaturedModels();
});
