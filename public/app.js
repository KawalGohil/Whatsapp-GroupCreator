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
    let progressState = {}; // To store timing information
    let currentBatchId = null;

    // --- UI State Functions ---
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

        // --- Add these lines to fully reset the UI state ---
        qrcodeDiv.innerHTML = '';
        statusDiv.classList.remove('hidden');
        displayStatus('Connecting to WhatsApp...', 'info');

        document.getElementById('log-file-select').innerHTML = '<option value="" disabled selected>Select a log file</option>';
    }

    function displayStatus(message, type = 'info') {
        statusDiv.textContent = message;
        statusDiv.className = `status ${type}`;
    }

    /**
     * FIX #1: This function is now self-contained and robust.
     */
    function toggleAuthView() {
        loginView.classList.toggle('hidden');
        registerView.classList.toggle('hidden');
    }

    // --- Socket Event Listeners ---
    socket.on('connect', () => console.log('Connected to WebSocket server'));
    socket.on('disconnect', (reason) => console.log('Disconnected:', reason));
    socket.on('connect_error', (error) => console.error('Connection error:', error));

     socket.on('qr', (qr) => {
        statusDiv.classList.remove('hidden'); // Ensure status text is visible for QR
        displayStatus('Scan QR code with WhatsApp', 'info');
        qrcodeDiv.innerHTML = ''; // Clear previous content (like the 'Ready' message)
        const canvas = document.createElement('canvas');

        // --- CHANGE THE WIDTH HERE from 256 to 200 ---
        QRCode.toCanvas(canvas, qr, { width: 200 }, (err) => { // This should match the CSS width for #qrcode
            if (err) {
                console.error('QR Code Error:', err);
                displayStatus('Error generating QR code.', 'error');
                return;
            }
            qrcodeDiv.appendChild(canvas);
        });
    });

    // --- REPLACE THIS BLOCK ---
    socket.on('status', (message) => {
        if (message.toLowerCase().includes('ready')) {
            // Hide the text status element and show the visual "Ready" state in the main box.
            statusDiv.classList.add('hidden');
            qrcodeDiv.innerHTML = `
                <div class="client-ready-container">
                    <div class="client-ready-icon">✓</div>
                    <div class="client-ready-title">Client Ready</div>
                    <div class="client-ready-subtitle">You can now create groups.</div>
                </div>`;
        } else {
            // For other statuses (like connecting), show the text status and ensure it's visible.
            statusDiv.classList.remove('hidden');
            displayStatus(message, 'info');
        }
    });

    socket.on('log_updated', () => {
        console.log('Log update received from server, refreshing log list.');
        fetchAndRenderLogs();
    });

     socket.on('upload_progress', (data) => {
        // Only update the UI if the progress event is for the current batch
        if (data.batchId !== currentBatchId) return;

        if (!progressState.startTime) {
            progressState.startTime = Date.now();
            progressState.total = data.total;
        }

        const percentage = Math.round((data.current / data.total) * 100);
        const degrees = percentage * 3.6;
        
        const $ppc = document.querySelector('.progress-pie-chart');
        const $span = document.getElementById('progress-percentage');
        
        $ppc.style.background = `conic-gradient(var(--primary-color) ${degrees}deg, #e5e5e5 ${degrees}deg)`;
        $span.textContent = `${percentage}%`;
        
        const elapsedMs = Date.now() - progressState.startTime;
        const avgTimePerGroup = elapsedMs / data.current;
        const remainingGroups = data.total - data.current;
        const remainingMs = Math.round(remainingGroups * avgTimePerGroup);
        const remainingMinutes = Math.floor(remainingMs / 60000);
        const remainingSeconds = Math.round((remainingMs % 60000) / 1000);
        const timeString = remainingMinutes > 0 ? `~${remainingMinutes}m ${remainingSeconds}s` : `~${remainingSeconds}s`;

        uploadStatusText.innerHTML = `Processing group ${data.current} of ${data.total}: <b>${data.currentGroup}</b><br>Time remaining: ${timeString}`;
    });

    // Listen for the final completion of the batch
    socket.on('batch_complete', (data) => {
        // Only show completion if it's for the current batch
        if (data.batchId !== currentBatchId) return;

        let message = `✅<br><b>Processing complete!</b><br>${data.successCount} of ${data.total} groups processed.`;
        if (data.failedCount > 0) {
            message += `<br><span style="color: var(--error-color);">${data.failedCount} groups failed or were skipped.</span>`;
        }
        uploadStatusText.innerHTML = message;
        progressState = {};
        currentBatchId = null; // Clear the batch ID
        setTimeout(() => {
            uploadStatusSection.classList.add('hidden');
        }, 8000);
    });
    // --- Form Event Listeners ---
    loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // --- FIX: Read values BEFORE resetting the form ---
    const username = loginForm.querySelector('#login-username').value;
    const password = loginForm.querySelector('#login-password').value;

    showLogin(); // Now it's safe to reset the UI for the new login attempt

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const data = await response.json();
        if (response.ok) {
            showApp(username);
            showToast('Login successful!', 'success');
        } else {
            loginStatus.textContent = data.message || 'Login failed.';
        }
    } catch (error) {
        loginStatus.textContent = 'Error connecting to server.';
    }
});

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = registerForm.querySelector('#register-username').value;
        const password = registerForm.querySelector('#register-password').value;
        try {
            const response = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            const data = await response.json();
            if (response.ok) {
                showApp(username);
            } else {
                registerStatus.textContent = data.message || 'Registration failed.';
            }
        } catch (error) {
            registerStatus.textContent = 'Error connecting to server.';
        }
    });
    
    logoutButton.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        showLogin();
    });

    // --- Find this event listener ---
    groupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const mode = groupForm.querySelector('input[name="input-mode"]:checked').value;
        const submitButton = groupForm.querySelector('button[type="submit"]');

        if (mode === 'csv' && contactsInput.files.length === 0) {
            showToast('Please select a CSV file to upload.', 'error');
            return;
        }

        submitButton.disabled = true;
        submitButton.textContent = 'Processing...';

        try {
            if (mode === 'manual') {
                // ... (manual logic is unchanged)
            } else { // CSV mode
                progressState = {}; // Reset timer
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
                    // --- THIS IS THE FIX ---
                    // The backend now gives us the batchId and total.
                    // We store it and prepare the UI for progress updates.
                    currentBatchId = result.batchId;
                    uploadStatusText.textContent = `Queued ${result.total} groups for creation...`;
                    document.getElementById('progress-percentage').textContent = '0%';
                    document.querySelector('.progress-pie-chart').style.background = `conic-gradient(var(--primary-color) 0deg, #e5e5e5 0deg)`;
                } else {
                    showToast(result.message, 'error');
                }
            }
        } catch (error) {
            showToast('An unexpected error occurred.', 'error');
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = 'Create Group';
            contactsInput.value = ''; // Clear the file input
        }
    });

    // Event listeners for toggling views
    toggleRegisterLink.addEventListener('click', toggleAuthView);
    toggleLoginLink.addEventListener('click', toggleAuthView);

    /**
     * FIX #2: This listener now correctly manages the `required` attribute.
     */
    document.querySelectorAll('input[name="input-mode"]').forEach(radio => {
        radio.addEventListener('change', function() {
            const isManual = this.value === 'manual';
            manualInputSection.classList.toggle('hidden', !isManual);
            fileInputSection.classList.toggle('hidden', isManual);
            
            // Update required attributes to prevent form errors
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
            logFileSelect.innerHTML = '';

            if (logs.length === 0) {
                logFileSelect.innerHTML = '<option value="" disabled selected>No logs available yet</option>';
            } else {
                logs.forEach(log => {
                    const option = document.createElement('option');
                    option.value = log.filename;
                    option.textContent = log.display;
                    logFileSelect.appendChild(option);
                });
            }
        } catch (error) {
            console.error('Error fetching logs:', error);
            logFileSelect.innerHTML = '<option value="" disabled selected>Error loading logs</option>';
        }
    }

   // --- Log File Download Listener ---
    document.getElementById('download-invite-log-btn').addEventListener('click', () => {
        const selectedLogFile = document.getElementById('log-file-select').value;
        if (!selectedLogFile) {
            showToast('Please select a log file to download.', 'error');
            return;
        }
        window.location.href = `/api/groups/download-log/${selectedLogFile}`;
    });

    // --- Initial Load ---
    (async function checkInitialAuth() {
        const response = await fetch('/api/auth/check-auth');
        if (response.ok) {
            const { user } = await response.json();
            showApp(user.username);
            fetchAndRenderLogs(); // Fetch logs on initial load
        } else {
            showLogin();
        }
    })();
});