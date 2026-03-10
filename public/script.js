// --- GLOBAL VARIABLES & SECURITY ---
const SITE_PASSWORD = "audit"; 
let currentPdfBase64 = null; 
let availableTokens = null; // NEW: Tracks tokens locally to prevent order-of-execution bugs

// --- INITIALIZATION (Runs on page load) ---
window.onload = async () => {
    // 1. Fetch live token count from the server
    try {
        const statusRes = await fetch('/api/status');
        const statusData = await statusRes.json();
        availableTokens = statusData.tokens; // Store in global variable
        document.getElementById('tokenCount').innerText = availableTokens;
    } catch (err) {
        document.getElementById('tokenCount').innerText = "Error";
    }

    // 2. Check for Stripe Payment Success
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('payment') === 'success') {
        alert("Payment successful! Your audits have been reloaded.");
        window.history.replaceState({}, document.title, window.location.pathname); 
        availableTokens = 10;
        document.getElementById('tokenCount').innerText = "10";
    }

    // 3. Check Password State
    if (localStorage.getItem('freight_mvp_unlocked') === 'true') {
        document.getElementById('passwordModal')?.style.setProperty('display', 'none');
        document.getElementById('welcomeModal')?.style.setProperty('display', 'flex');
    } else {
        document.getElementById('passwordModal')?.style.setProperty('display', 'flex');
    }
};

function checkPassword() {
    const input = document.getElementById('sitePassword').value;
    if (input === SITE_PASSWORD) {
        localStorage.setItem('freight_mvp_unlocked', 'true');
        document.getElementById('passwordModal').style.display = 'none';
        document.getElementById('welcomeModal').style.display = 'flex';
    } else {
        document.getElementById('passwordError').style.display = 'block';
    }
}

// --- MODAL CONTROLS ---
function closeModal() { document.getElementById('welcomeModal').style.display = 'none'; }
function closeAlert() { document.getElementById('alertModal').style.display = 'none'; }

// --- FILE UI UPDATES ---
function updateFileCount() {
    const input = document.getElementById('fileInput');
    const fileList = document.getElementById('fileList');
    const fileCount = document.getElementById('fileCount');
    
    fileList.innerHTML = "";
    if (input.files.length > 0) {
        fileCount.innerText = `${input.files.length} document(s) ready.`;
        let html = "<ul style='margin:5px 0; padding-left:20px; color: #555;'>";
        for (let file of input.files) html += `<li><strong>${file.name}</strong></li>`;
        html += "</ul>";
        fileList.innerHTML = html;
    } else {
        fileCount.innerText = "";
    }
}

// --- MAIN AUDIT SUBMISSION ---
document.getElementById('auditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // 🛑 NEW: Check tokens BEFORE checking file counts or extensions
    if (availableTokens === 0) {
        document.getElementById('paywallModal').style.display = 'flex';
        return; // Halt immediately. Do not show file alerts.
    }

    const fileInput = document.getElementById('fileInput');
    
    if (fileInput.files.length === 0) return alert("Select documents first.");

    if (fileInput.files.length > 3) {
        return alert("🚫 MAX LIMIT EXCEEDED: Please select a maximum of 3 documents (Rate Con, BOL, Invoice).");
    }

    const allowedExtensions = ['.pdf', '.csv', '.txt'];
    for (let file of fileInput.files) {
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            return alert(`🚫 INVALID FILE TYPE: "${file.name}".\n\nThis MVP only accepts PDF, CSV, or TXT files. Please remove it and try again.`);
        }
    }

    const btn = document.getElementById('submitBtn');
    const loadingBox = document.getElementById('loadingBox');
    const progressBar = document.getElementById('progressBar');
    const statusText = document.getElementById('loadingStatusText');
    const results = document.getElementById('results');
    const alertModal = document.getElementById('alertModal');

    // Reset UI
    btn.disabled = true;
    loadingBox.style.display = 'block';
    results.style.display = 'none';
    if (alertModal) alertModal.style.display = 'none';
    
    const pdfBtn = document.getElementById('downloadPdfBtn');
    if (pdfBtn) pdfBtn.style.display = 'none'; 
    
    progressBar.style.width = '0%';

    statusText.innerText = "Initializing AI model...";
    
    // --- DYNAMIC TIMER LOGIC ---
    let timeLeft = 8;
    const timerDisplay = document.getElementById('timer-count');
    
    // Ensure the display resets to 8 every time
    if (timerDisplay) timerDisplay.innerText = timeLeft;

    const countdown = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
            if (timerDisplay) timerDisplay.innerText = "1"; // Hold at 1 so it doesn't hit 0/negative
            clearInterval(countdown);
        } else {
            if (timerDisplay) timerDisplay.innerText = timeLeft;
        }
    }, 1000);

    const formData = new FormData();
    for (let file of fileInput.files) formData.append('documents', file);

    let progress = 0;
    const progressInterval = setInterval(() => {
        progress += Math.random() * 15;
        if (progress > 90) progress = 90;
        progressBar.style.width = `${progress}%`;
        if (progress > 40) statusText.innerText = "Cross-referencing line items...";
    }, 800);

    try {
        const response = await fetch('/api/audit', { method: 'POST', body: formData });
        
        // Failsafe 403 Interception (In case the frontend token count is out of sync)
        if (response.status === 403) {
            clearInterval(progressInterval);
            loadingBox.style.display = 'none';
            availableTokens = 0; // Force sync
            document.getElementById('tokenCount').innerText = "0";
            document.getElementById('paywallModal').style.display = 'flex';
            btn.disabled = false;
            return; 
        }

        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || "Server processing failed.");

        // Sync Live Token Count
        if (data.tokens_remaining !== undefined) {
            availableTokens = data.tokens_remaining;
            document.getElementById('tokenCount').innerText = availableTokens;
        }

        progressBar.style.width = '100%';
        statusText.innerText = "Complete!";
        await new Promise(r => setTimeout(r, 300)); 

        const statusBox = document.getElementById('statusBox');
        statusBox.style.background = data.audit_summary.match_status ? '#d4edda' : '#f8d7da';
        statusBox.style.color = data.audit_summary.match_status ? '#155724' : '#721c24';
        statusBox.innerText = data.audit_summary.match_status ? "✅ MATCH VERIFIED" : "🚨 DISCREPANCY DETECTED";

        const detailedNotes = data.discrepancy_details || "No detailed notes provided.";
        document.getElementById('reportNotes').innerText = detailedNotes;
        document.getElementById('reportNotes').style.color = data.audit_summary.match_status ? '#333' : 'red';

        const v = data.extracted_values || {};
        document.getElementById('dataTableBody').innerHTML = `
            <tr><td><strong>Rate Con</strong></td><td>$${v.rate_con?.total || '0'}</td><td>${v.rate_con?.weight || '-'} lbs</td></tr>
            <tr><td><strong>BOL</strong></td><td>${v.bol?.declared_value ? '$' + v.bol.declared_value : '-'}</td><td>${v.bol?.weight || '-'} lbs</td></tr>
            <tr><td><strong>Invoice</strong></td><td>$${v.invoice?.total || '0'}</td><td>${v.invoice?.weight || '-'} lbs</td></tr>
        `;

        results.style.display = 'block';

        if (data.pdf_download) {
            currentPdfBase64 = data.pdf_download;
            if (pdfBtn) pdfBtn.style.display = 'block';
        }

        if (!data.audit_summary.match_status) {
            const alertList = document.getElementById('alertMessageList');
            alertList.innerHTML = ''; 
            const tldrArray = data.discrepancy_tldr || ["Discrepancy detected. See notes for details."];
            tldrArray.forEach(bullet => {
                const li = document.createElement('li');
                li.innerText = bullet;
                alertList.appendChild(li);
            });
            if (alertModal) alertModal.style.display = 'flex';
        }

    } catch (err) {
        console.error("❌ ERROR:", err);
        let errorMsg = "The AI was unable to parse the documents.";
        if (err.name === 'AbortError') errorMsg = "Timeout: The files were too large or the AI took too long to respond (over 20s).";
        else if (err.message) errorMsg = err.message;

        const errorTextEl = document.getElementById('errorMessageText');
        if (errorTextEl) errorTextEl.innerText = errorMsg;
        
        const errorModal = document.getElementById('errorModal');
        if (errorModal) errorModal.style.display = 'flex';
        
    } finally {
        clearInterval(countdown); 
        clearInterval(progressInterval);
        btn.disabled = false;
        loadingBox.style.display = 'none';
    }
});

// --- PDF DOWNLOAD LOGIC ---
const downloadPdfBtn = document.getElementById('downloadPdfBtn');
if (downloadPdfBtn) {
    downloadPdfBtn.addEventListener('click', () => {
        if (!currentPdfBase64) return;
        
        const link = document.createElement('a');
        link.href = `data:application/pdf;base64,${currentPdfBase64}`;
        link.download = `Freight_Audit_Dispute_${Date.now()}.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
}

// --- STRIPE CHECKOUT ---
async function triggerCheckout() {
    try {
        const res = await fetch('/api/checkout', { method: 'POST' });
        const data = await res.json();
        if (data.url) window.location.href = data.url; 
    } catch (err) {
        alert("Failed to initiate checkout. Please check your connection.");
    }
}

// --- WAITLIST LOGIC (With Anti-Spam) ---
async function joinWaitlist() {
    // 1. Check if this device already signed up
    if (localStorage.getItem('freight_waitlist_joined') === 'true') {
        return alert("You are already on the waitlist!");
    }

    const emailInput = document.getElementById('waitlistEmail');
    const email = emailInput.value;
    const btn = event.target; // Gets the button that was clicked

    if (!email.includes('@')) return alert("Please enter a valid email address.");
    
    // 2. Disable the button instantly to prevent double-clicks
    btn.disabled = true;
    btn.innerText = "Joining...";
    btn.style.background = "#555";
    
    try {
        const res = await fetch('/api/waitlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        
        if (res.ok) {
            // 3. Lock this device out from future signups
            localStorage.setItem('freight_waitlist_joined', 'true');
            document.getElementById('waitlistSuccess').style.display = 'block';
            emailInput.style.display = 'none'; // Hide the input field
            btn.style.display = 'none'; // Hide the button completely
        } else {
            throw new Error("Server rejected");
        }
    } catch (err) {
        alert("Error joining the waitlist. Please try again.");
        btn.disabled = false;
        btn.innerText = "Join Waitlist";
        btn.style.background = "#003366";
    }
}