// --- SECURITY SETTINGS ---
const SITE_PASSWORD = "audit"; // Change this to whatever you want!

// Run this the second the page loads
window.onload = () => {
    if (localStorage.getItem('freight_mvp_unlocked') === 'true') {
        document.getElementById('passwordModal').style.display = 'none';
        document.getElementById('welcomeModal').style.display = 'flex'; // Show welcome instead
    } else {
        document.getElementById('passwordModal').style.display = 'flex';
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

// MODAL CONTROLS
function closeModal() { document.getElementById('welcomeModal').style.display = 'none'; }
function closeAlert() { document.getElementById('alertModal').style.display = 'none'; }

// UPDATE FILE UI
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

// MAIN SUBMIT FUNCTION
document.getElementById('auditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('fileInput');
    
    if (fileInput.files.length === 0) return alert("Select documents first.");

    // 🛑 NEW: Stop them if they select more than 3 files
    if (fileInput.files.length > 3) {
        return alert("🚫 MAX LIMIT EXCEEDED: Please select a maximum of 3 documents (Rate Con, BOL, Invoice).");
    }

    // --- STRICT FILE TYPE VALIDATION ---
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

    // RESET UI
    btn.disabled = true;
    loadingBox.style.display = 'block';
    results.style.display = 'none';
    alertModal.style.display = 'none';
    progressBar.style.width = '0%';
    statusText.innerText = "Initializing AI model...";

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
        const data = await response.json();
        if (data.error) throw new Error(data.error);

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

        // ... (inside the try block)
        const v = data.extracted_values || {};
        
        // UPDATED: Now looks for bol.declared_value
        document.getElementById('dataTableBody').innerHTML = `
            <tr><td><strong>Rate Con</strong></td><td>$${v.rate_con?.total || '0'}</td><td>${v.rate_con?.weight || '-'} lbs</td></tr>
            <tr><td><strong>BOL</strong></td><td>${v.bol?.declared_value ? '$' + v.bol.declared_value : '-'}</td><td>${v.bol?.weight || '-'} lbs</td></tr>
            <tr><td><strong>Invoice</strong></td><td>$${v.invoice?.total || '0'}</td><td>${v.invoice?.weight || '-'} lbs</td></tr>
        `;

        results.style.display = 'block';

        if (!data.audit_summary.match_status) {
            // ... (keep your existing alert modal logic here)
            const alertList = document.getElementById('alertMessageList');
            alertList.innerHTML = ''; 
            const tldrArray = data.discrepancy_tldr || ["Discrepancy detected. See notes for details."];
            tldrArray.forEach(bullet => {
                const li = document.createElement('li');
                li.innerText = bullet;
                alertList.appendChild(li);
            });
            alertModal.style.display = 'flex';
        }

    } catch (err) {
        console.error("❌ ERROR:", err);
        // NEW: Trigger the Failsafe Modal instead of a generic alert
        let errorMsg = "The AI was unable to parse the documents.";
        if (err.name === 'AbortError') errorMsg = "Timeout: The files were too large or the AI took too long to respond (over 20s).";
        else if (err.message) errorMsg = err.message;

        document.getElementById('errorMessageText').innerText = errorMsg;
        document.getElementById('errorModal').style.display = 'flex';
        
    } finally {
        clearInterval(progressInterval);
        btn.disabled = false;
        loadingBox.style.display = 'none';
    }
});