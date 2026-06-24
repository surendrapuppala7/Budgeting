import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    initializeAppCheck,
    ReCaptchaV3Provider
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js";
import {
    getAuth,
    signInWithRedirect,
    getRedirectResult,
    GoogleAuthProvider,
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getFirestore,
    collection,
    query,
    orderBy,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCyYAuJLi67EdCu4FvIEr4QsKCgvlKWXrw",
    authDomain: "ledger.itcyber.cc",
    projectId: "ledger-d3ec5",
    storageBucket: "ledger-d3ec5.firebasestorage.app",
    messagingSenderId: "1024737940441",
    appId: "1:1024737940441:web:670e3c2a660e989f5fffc8"
};

const app = initializeApp(firebaseConfig);

initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider("6LeLWgAtAAAAAL7HnrAOoNaTdHdqqNUumr1TVKlB"),
    isTokenAutoRefreshEnabled: true
});

const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let unsubscribeUsage = null;

const $ = (id) => document.getElementById(id);

function setHidden(node, hidden) {
    if (!node) return;
    node.classList.toggle('hidden', Boolean(hidden));
}

function createEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function formatDate(timestamp) {
    const time = Number(timestamp || 0);

    if (!time) {
        return 'Never';
    }

    return new Date(time).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

function safeCount(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? Math.max(0, Math.trunc(num)) : 0;
}

async function login() {
    const btn = $('adminLoginBtn');

    try {
        btn.disabled = true;
        btn.textContent = 'Opening Google...';

        await signInWithRedirect(auth, provider);
    } catch (error) {
        console.error('Admin sign-in failed:', error);

        alert(
            `Admin sign-in failed.\n\n` +
            `Code: ${error.code || 'unknown'}\n\n` +
            `${error.message || error}`
        );

        btn.disabled = false;
        btn.textContent = 'Sign in with Google';
    }
}

async function logout() {
    if (unsubscribeUsage) {
        unsubscribeUsage();
        unsubscribeUsage = null;
    }

    await signOut(auth);
}

function statCard(label, value) {
    const card = createEl('div', 'admin-stat-card');

    const labelEl = createEl('span', '', label);
    const valueEl = createEl('strong', '', value);

    card.append(labelEl, valueEl);
    return card;
}

function renderStats(rows) {
    const now = Date.now();
    const activeTodayCutoff = now - 24 * 60 * 60 * 1000;
    const activeWeekCutoff = now - 7 * 24 * 60 * 60 * 1000;

    const totalUsers = rows.length;
    const activeToday = rows.filter(row => Number(row.lastActiveAt || 0) >= activeTodayCutoff).length;
    const activeWeek = rows.filter(row => Number(row.lastActiveAt || 0) >= activeWeekCutoff).length;
    const householdCount = rows.filter(row => row.isHouseholdOwner === true).length;
    const transactionCount = rows.reduce((sum, row) => sum + safeCount(row.transactionCount), 0);
    const latestActivity = rows[0]?.lastActiveAt ? formatDate(rows[0].lastActiveAt) : 'No activity yet';

    $('adminStats').replaceChildren(
        statCard('Total Users', totalUsers),
        statCard('Active Today', activeToday),
        statCard('Active 7 Days', activeWeek),
        statCard('Households', householdCount),
        statCard('Transaction Count', transactionCount),
        statCard('Latest Activity', latestActivity)
    );
}

function renderRows(rows) {
    const tbody = $('adminUserRows');
    tbody.replaceChildren();

    if (!rows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.textContent = 'No usage data yet.';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
    }

    rows.forEach((row, index) => {
        const tr = document.createElement('tr');

        const cells = [
            `User ${index + 1}`,
            formatDate(row.lastActiveAt),
            safeCount(row.transactionCount),
            safeCount(row.goalCount),
            safeCount(row.categoryCount),
            row.isHouseholdOwner
                ? `Owner • ${safeCount(row.householdMemberCount)} member(s)`
                : `Member • ${safeCount(row.householdMemberCount)} member(s)`,
            row.appVersion || 'unknown'
        ];

        cells.forEach(value => {
            const td = document.createElement('td');
            td.textContent = String(value);
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
}

function startAdminDashboard() {
    if (unsubscribeUsage) {
        unsubscribeUsage();
    }

    const usageQuery = query(
        collection(db, 'usageHeartbeats'),
        orderBy('lastActiveAt', 'desc')
    );

    unsubscribeUsage = onSnapshot(
        usageQuery,
        (snapshot) => {
            const rows = [];

            snapshot.forEach((docSnap) => {
                rows.push(docSnap.data());
            });

            renderStats(rows);
            renderRows(rows);

            $('adminStatus').textContent = 'Connected. Showing anonymous usage health only.';
        },
        (error) => {
            console.error('Admin dashboard failed:', error);

            $('adminStatus').textContent =
                'Access denied or rules not deployed. Make sure your Firebase UID is in isAdmin().';

            renderStats([]);
            renderRows([]);
        }
    );
}

function bindEvents() {
    $('adminLoginBtn').addEventListener('click', login);
    $('adminLogoutBtn').addEventListener('click', logout);
}

bindEvents();

getRedirectResult(auth).catch((error) => {
    console.error('Admin redirect result failed:', error);

    alert(
        `Admin sign-in failed.\n\n` +
        `Code: ${error.code || 'unknown'}\n\n` +
        `${error.message || error}`
    );
});

onAuthStateChanged(auth, (user) => {
    if (user) {
        setHidden($('adminLoginScreen'), true);
        setHidden($('adminScreen'), false);
        startAdminDashboard();
    } else {
        if (unsubscribeUsage) {
            unsubscribeUsage();
            unsubscribeUsage = null;
        }

        setHidden($('adminLoginScreen'), false);
        setHidden($('adminScreen'), true);
    }
});
