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

    // --- UI State Functions ---
    function showApp(username) {
        authContainer.classList.add('hidden');
        appContainer.classList.remove('hidden');
        displayStatus('Initializing session...', 'info');
        if (!socket.connected) {
            socket.connect();
        }
        // You can add logic here to fetch logs, etc.
    }

    function showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        
        // Trigger the animation
        setTimeout(() => toast.classList.add('show'), 10);

        // Hide and remove the toast after 4 seconds
        setTimeout(() => {
            toast.classList.remove('show');
            toast.addEventListener('transitionend', () => toast.remove());
        }, 4000);
    }

    function showLogin() {
        authContainer.classList.remove('hidden');
        appContainer.classList.add('hidden');
        socket.disconnect();
        loginForm.reset();
        registerForm.reset();
        loginStatus.textContent = '';
        registerStatus.textContent = '';
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
        displayStatus('Scan QR code with WhatsApp', 'info');
        qrcodeDiv.innerHTML = '';
        const canvas = document.createElement('canvas');
        QRCode.toCanvas(canvas, qr, { width: 256 }, (err) => {
            if (err) {
                console.error('QR Code Error:', err);
                displayStatus('Error generating QR code.', 'error');
                return;
            }
            qrcodeDiv.appendChild(canvas);
        });
    });

    socket.on('status', (message) => {
        if (message.toLowerCase().includes('ready')) {
            displayStatus('Client is ready!', 'success');
            qrcodeDiv.innerHTML = `<h2>✅ Client Ready</h2>`;
        } else {
            displayStatus(message, 'info');
        }
    });

    socket.on('log_updated', () => {
        console.log('Log update received from server, refreshing log list.');
        fetchAndRenderLogs();
    });

    // --- Form Event Listeners ---
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = loginForm.querySelector('#login-username').value;
        const password = loginForm.querySelector('#login-password').value;
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

    groupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const mode = groupForm.querySelector('input[name="input-mode"]:checked').value;
        const submitButton = groupForm.querySelector('button[type="submit"]');
        submitButton.disabled = true;
        submitButton.textContent = 'Processing...';

        try {
            let response;
            if (mode === 'manual') {
                const groupName = groupNameInput.value;
                const numbers = document.getElementById('manualNumbers').value;
                response = await fetch('/api/groups/create-manual', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ groupName, numbers }),
                });
            } else { // CSV mode
                const formData = new FormData();
                formData.append('contacts', contactsInput.files[0]);
                response = await fetch('/api/groups/upload-csv', {
                    method: 'POST',
                    body: formData,
                });
            }
            const result = await response.json();
           showToast(result.message, response.ok ? 'success' : 'error');
        } catch (error) {
            showToast('An unexpected error occurred.', 'error');
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = 'Create Group';
            groupForm.reset();
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
            logFileSelect.innerHTML = ''; // Clear existing options

            if (logs.length === 0) {
                logFileSelect.innerHTML = '<option value="" disabled selected>No logs available yet</option>';
                return;
            }

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

    /**
     * Handles the download button click event.
     */
    document.getElementById('download-invite-log-btn').addEventListener('click', () => {
        const selectedLogFile = document.getElementById('log-file-select').value;
        if (!selectedLogFile) {
            alert('Please select a log file to download.');
            return;
        }
        // Create a temporary link to trigger the download
        const link = document.createElement('a');
        link.href = `/api/groups/download-log/${selectedLogFile}`;
        link.download = selectedLogFile;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
    
    // --- Initial Load ---
    (async function checkInitialAuth() {
        const response = await fetch('/api/auth/check-auth');
        if (response.ok) {
            const { user } = await response.json();
            showApp(user.username);
            fetchAndRenderLogs(); // Fetch logs right after showing the app
        } else {
            showLogin();
        }
    })();
});