window.addEventListener('DOMContentLoaded', () => {
    // Initialize Socket.IO client
    const socket = io({
        autoConnect: false,
        withCredentials: true,
    });

    // --- DOM Elements ---
    const authContainer = document.getElementById('auth-container');
    const appContainer = document.getElementById('app-container');
    const loginView = document.getElementById('login-view');
    const registerView = document.getElementById('register-view');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const loginStatus = document.getElementById('login-status');
    const registerStatus = document.getElementById('register-status');
    const qrcodeDiv = document.getElementById('qrcode');
    const statusDiv = document.getElementById('status');
    const groupForm = document.getElementById('group-form');
    const logoutButton = document.getElementById('logout-button');
    const manualInputSection = document.getElementById('manual-input-section');
    const fileInputSection = document.getElementById('file-input-section');
    const groupNameInput = document.getElementById('groupName');
    const contactsInput = document.getElementById('contacts');
    const toggleLoginLink = document.getElementById('toggle-login');
    const toggleRegisterLink = document.getElementById('toggle-register');
    const uploadStatusSection = document.getElementById('upload-status-section');
    const uploadStatusText = document.getElementById('upload-status-text');
    
    let progressState = {};
    let currentBatchId = null;
    
    // --- ✅ FIX #1: Cache for early progress updates ---
    const progressCache = {};

    // --- UI State Functions (no changes) ---
    function showApp(username) {
        authContainer.classList.add('hidden');
        appContainer.classList.remove('hidden');
        displayStatus('Initializing session...', 'info');
        if (!socket.connected) {
            socket.connect();
        }
        fetchAndRenderLogs();
    }

    function showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            toast.addEventListener('transitionend', () => toast.remove());
        }, 4000);
    }

    function showLogin() {
        authContainer.classList.remove('hidden');
        appContainer.classList.add('hidden');
        if (socket.connected) {
            socket.disconnect();
        }
        loginForm.reset();
        registerForm.reset();
        loginStatus.textContent = '';
        registerStatus.textContent = '';
        qrcodeDiv.innerHTML = '';
        statusDiv.classList.remove('hidden');
        displayStatus('Connecting to WhatsApp...', 'info');
        document.getElementById('log-file-select').innerHTML = '<option value="" disabled selected>Select a log file</option>';
    }

    function displayStatus(message, type = 'info') {
        statusDiv.textContent = message;
        statusDiv.className = `status ${type}`;
    }

    function toggleAuthView() {
        loginView.classList.toggle('hidden');
        registerView.classList.toggle('hidden');
    }

    // --- Socket Event Listeners ---
    socket.on('connect', () => console.log('Connected to WebSocket server'));
    socket.on('disconnect', (reason) => console.log('Disconnected:', reason));
    socket.on('connect_error', (error) => console.error('Connection error:', error));

    socket.on('qr', (qr) => {
        displayStatus('Scan QR code with WhatsApp', 'info');
        qrcodeDiv.innerHTML = '';
        const canvas = document.createElement('canvas');
        QRCode.toCanvas(canvas, qr, { width: 200 }, (err) => {
            if (err) {
                displayStatus('Error generating QR code.', 'error');
                return;
            }
            qrcodeDiv.appendChild(canvas);
        });
    });

    socket.on('status', (message) => {
        if (message.toLowerCase().includes('ready')) {
            statusDiv.classList.add('hidden');
            qrcodeDiv.innerHTML = `<div class="client-ready-container"><div class="client-ready-icon">✓</div><div class="client-ready-title">Client Ready</div><div class="client-ready-subtitle">You can now create groups.</div></div>`;
        } else {
            statusDiv.classList.remove('hidden');
            displayStatus(message, 'info');
        }
    });

    socket.on('log_updated', () => fetchAndRenderLogs());

    // --- ✅ FIX #2: Smarter progress update function ---
    function updateProgressUI(data) {
        if (!progressState.startTime) {
            progressState.startTime = Date.now();
        }
        const percentage = Math.round((data.current / data.total) * 100);
        const degrees = percentage * 3.6;
        
        const pieChart = document.querySelector('.progress-pie-chart');
        const percentageText = document.getElementById('progress-percentage');
        
        if (pieChart) pieChart.style.background = `conic-gradient(var(--primary-color) ${degrees}deg, #e5e5e5 ${degrees}deg)`;
        if (percentageText) percentageText.textContent = `${percentage}%`;
        
        const elapsedMs = Date.now() - progressState.startTime;
        const avgTimePerGroup = elapsedMs / data.current;
        const remainingGroups = data.total - data.current;
        const remainingMs = Math.round(remainingGroups * avgTimePerGroup);
        const remainingMinutes = Math.floor(remainingMs / 60000);
        const remainingSeconds = Math.round((remainingMs % 60000) / 1000);
        const timeString = remainingMinutes > 0 ? `~${remainingMinutes}m ${remainingSeconds}s` : `~${remainingSeconds}s`;

        uploadStatusText.innerHTML = `Processing group ${data.current} of ${data.total}: <b>${data.currentGroup}</b><br>Time remaining: ${timeString}`;
    }

    socket.on('batch_progress', (data) => {
        // If the current batchId isn't set yet, cache the progress.
        if (!currentBatchId || data.batchId !== currentBatchId) {
            progressCache[data.batchId] = data;
            return;
        }
        updateProgressUI(data);
    });

    socket.on('batch_complete', (data) => {
        if (data.batchId !== currentBatchId) return;

        let message = `✅<br><b>Processing complete!</b><br>${data.successCount} of ${data.total} groups processed.`;
        if (data.failedCount > 0) {
            message += `<br><span style="color: var(--error-color);">${data.failedCount} groups failed or were skipped.</span>`;
        }
        uploadStatusText.innerHTML = message;
        progressState = {};
        currentBatchId = null;
        setTimeout(() => uploadStatusSection.classList.add('hidden'), 8000);
    });

    // --- Form Event Listeners (with final fix) ---
    groupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const mode = groupForm.querySelector('input[name="input-mode"]:checked').value;
        const submitButton = groupForm.querySelector('button[type="submit"]');
        const formElements = groupForm.querySelectorAll('input, textarea, button');

        if (mode === 'csv' && contactsInput.files.length === 0) {
            showToast('Please select a CSV file to upload.', 'error');
            return;
        }

        if (mode === 'manual') {
            const numbers = document.getElementById('manualNumbers').value.split(/[,\n]/).filter(Boolean);
            if (numbers.length < 1) {
                showToast('Please provide at least one participant phone number.', 'error');
                return;
            }
        }

        formElements.forEach(el => el.disabled = true);
        submitButton.textContent = 'Processing...';

        try {
            if (mode === 'manual') {
                const groupName = document.getElementById('groupName').value;
                const numbers = document.getElementById('manualNumbers').value;
                const desiredAdminNumber = document.getElementById('desiredAdminNumber').value;

                const response = await fetch('/api/groups/create-manual', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ groupName, numbers, desiredAdminNumber }),
                });
                const result = await response.json();
                showToast(result.message, response.ok ? 'success' : 'error');
            } else { // CSV mode
                progressState = {};
                uploadStatusSection.classList.remove('hidden');
                uploadStatusText.textContent = 'Uploading and preparing...';
                
                const formData = new FormData();
                formData.append('contacts', contactsInput.files[0]);
                
                const response = await fetch('/api/groups/upload-csv', {
                    method: 'POST',
                    body: formData,
                });
                
                const result = await response.json();
                if (response.ok) {
                    currentBatchId = result.batchId;
                    uploadStatusText.textContent = `Queued ${result.total} groups for creation...`;
                    document.getElementById('progress-percentage').textContent = '0%';
                    document.querySelector('.progress-pie-chart').style.background = `conic-gradient(var(--primary-color) 0deg, #e5e5e5 0deg)`;

                    // --- ✅ FIX #3: Check the cache for early updates ---
                    if (progressCache[currentBatchId]) {
                        updateProgressUI(progressCache[currentBatchId]);
                        delete progressCache[currentBatchId]; // Clean up
                    }

                } else {
                    showToast(result.message || 'An error occurred during upload.', 'error');
                }
            }
        } catch (error) {
            showToast('An unexpected error occurred.', 'error');
        } finally {
            formElements.forEach(el => el.disabled = false);
            submitButton.textContent = 'Create Group';
            
            if (mode === 'manual') {
                document.getElementById('groupName').value = '';
                document.getElementById('manualNumbers').value = '';
                document.getElementById('desiredAdminNumber').value = '';
            } else {
                contactsInput.value = '';
            }
        }
    });

    // --- Other Listeners (no changes) ---
    document.querySelectorAll('input[name="input-mode"]').forEach(radio => {
        radio.addEventListener('change', function() {
            const isManual = this.value === 'manual';
            manualInputSection.classList.toggle('hidden', !isManual);
            fileInputSection.classList.toggle('hidden', isManual);
            groupNameInput.required = isManual;
            contactsInput.required = !isManual;
        });
    });

    async function fetchAndRenderLogs() {
        const logFileSelect = document.getElementById('log-file-select');
        try {
            const response = await fetch('/api/groups/list-logs');
            if (!response.ok) throw new Error('Failed to fetch logs');
            const logs = await response.json();
            logFileSelect.innerHTML = '<option value="" disabled selected>Select a log file</option>';
            logs.forEach(log => {
                const option = document.createElement('option');
                option.value = log.filename;
                option.textContent = log.display;
                logFileSelect.appendChild(option);
            });
        } catch (error) {
            console.error('Error fetching logs:', error);
            logFileSelect.innerHTML = '<option value="" disabled selected>Error loading logs</option>';
        }
    }

    document.getElementById('download-invite-log-btn').addEventListener('click', () => {
        const selectedLogFile = document.getElementById('log-file-select').value;
        if (!selectedLogFile) {
            showToast('Please select a log file to download.', 'error');
            return;
        }
        window.location.href = `/api/groups/download-log/${selectedLogFile}`;
    });

    (async function checkInitialAuth() {
        try {
            const response = await fetch('/api/auth/check-auth');
            if (response.ok) {
                const { user } = await response.json();
                showApp(user.username);
            } else {
                showLogin();
            }
        } catch (error) {
            showLogin();
        }
    })();
});