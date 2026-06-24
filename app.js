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
    addDoc,
    query,
    where,
    onSnapshot,
    deleteDoc,
    doc,
    setDoc,
    getDoc,
    getDocs,
    orderBy
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
const APP_VERSION = 'redirect-login-2';

const palette = ['#111111', '#A63D2F', '#D99A5A', '#C2847A', '#7A8B76', '#4A5D4E', '#2B4C3B', '#8E8E93'];
const allowedTypes = new Set(['income', 'expense', 'savings']);

let currentUser = null;
let activeHouseholdId = null;
let household = null;

let unsubscribeTxs = null;
let unsubscribeSettings = null;
let unsubscribeGoals = null;
let unsubscribeHousehold = null;

let transactions = [];
let categories = [];
let wallets = [];
let recurring = [];
let goals = [];

let type = 'expense';
let modalTab = 'expense';
let editingItemId = null;
let activityFiltersBound = false;

const $ = (id) => document.getElementById(id);

function createEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function setHidden(node, hidden) {
    if (!node) return;
    node.classList.toggle('hidden', Boolean(hidden));
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

/*
    SECURITY MODEL

    Money fields:
    - Live-cleaned.
    - Allow only digits, one optional leading $, and one optional decimal point.
    - Saved to Firestore as a number only.

    Text fields:
    - NOT live-cleaned.
    - Preserves what user typed.
    - Rejected on Save if illegal characters exist.
    - Blocks script-useful characters such as:
      < > " ' ` = / \ ; : { } [ ] |

    Email fields:
    - Live-cleaned to lowercase email characters only.
*/

const TEXT_PATTERN = /^[A-Za-z0-9 .,!?\-_()$#@&+%]*$/;
const ILLEGAL_TEXT_PATTERN = /[^A-Za-z0-9 .,!?\-_()$#@&+%]/;

function cleanControlChars(value, max = 120) {
    return String(value || '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .trim()
        .slice(0, max);
}

function hasIllegalTextChars(value) {
    return ILLEGAL_TEXT_PATTERN.test(String(value || ''));
}

function filterPlainTextForDisplay(value, max = 120) {
    return cleanControlChars(value, max)
        .replace(ILLEGAL_TEXT_PATTERN, '')
        .slice(0, max);
}

function isSafePlainText(value, max = 120) {
    const raw = String(value || '');

    if (hasIllegalTextChars(raw)) {
        return false;
    }

    const text = cleanControlChars(raw, max);

    return Boolean(text) && TEXT_PATTERN.test(text);
}

function getSafePlainText(value, max = 120) {
    const raw = String(value || '');

    if (hasIllegalTextChars(raw)) {
        return null;
    }

    const text = cleanControlChars(raw, max);

    return isSafePlainText(text, max) ? text : null;
}

function filterMoneyInput(value) {
    let raw = String(value || '').replace(/[^0-9.$]/g, '');

    const hasDollar = raw.includes('$');
    raw = raw.replace(/\$/g, '');
    if (hasDollar) raw = `$${raw}`;

    const prefix = raw.startsWith('$') ? '$' : '';
    let body = raw.replace(/^\$/, '');

    const firstDot = body.indexOf('.');
    if (firstDot !== -1) {
        body = body.slice(0, firstDot + 1) + body.slice(firstDot + 1).replace(/\./g, '');
    }

    const parts = body.split('.');
    if (parts.length === 2) {
        parts[1] = parts[1].slice(0, 2);
        body = `${parts[0]}.${parts[1]}`;
    }

    body = body.slice(0, 12);
    return `${prefix}${body}`;
}

function validAmount(value, max = 1000000) {
    const raw = String(value || '').trim();

    if (!/^\$?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw)) {
        return null;
    }

    const num = Number(raw.replace('$', ''));

    if (!Number.isFinite(num) || num <= 0 || num > max) {
        return null;
    }

    return Math.round(num * 100) / 100;
}

function validNonNegative(value, max = 1000000) {
    const raw = String(value ?? '').trim();

    if (!/^\$?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw)) {
        return null;
    }

    const num = Number(raw.replace('$', ''));

    if (!Number.isFinite(num) || num < 0 || num > max) {
        return null;
    }

    return Math.round(num * 100) / 100;
}

function filterIntegerInput(value, maxLength = 3) {
    return String(value || '').replace(/[^0-9]/g, '').slice(0, maxLength);
}

function validInterval(value) {
    const raw = String(value || '').trim();

    if (!/^[1-9]\d*$/.test(raw)) {
        return null;
    }

    const num = Number.parseInt(raw, 10);

    if (!Number.isInteger(num) || num < 1 || num > 365) {
        return null;
    }

    return num;
}

function filterEmailInput(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9._%+\-@]/g, '')
        .replace(/@+/g, '@')
        .slice(0, 254);
}

function validateEmail(email) {
    const normalized = filterEmailInput(email);
    return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(normalized) ? normalized : '';
}

function safeText(value, max = 120) {
    return cleanControlChars(value, max);
}

function safeColor(color) {
    return palette.includes(color) ? color : '#111111';
}

function money(num) {
    return `$${Number(num || 0).toFixed(0)}`;
}

function money2(num) {
    return `$${Number(num || 0).toFixed(2)}`;
}

function showLoading(message = 'Loading Ledger...') {
    $('loadingOverlay').textContent = message;
    setHidden($('loadingOverlay'), false);
}

function hideLoading() {
    setHidden($('loadingOverlay'), true);
}

function clearSubscriptions() {
    if (unsubscribeTxs) unsubscribeTxs();
    if (unsubscribeSettings) unsubscribeSettings();
    if (unsubscribeGoals) unsubscribeGoals();
    if (unsubscribeHousehold) unsubscribeHousehold();

    unsubscribeTxs = null;
    unsubscribeSettings = null;
    unsubscribeGoals = null;
    unsubscribeHousehold = null;
}

function defaultSettings() {
    return {
        categories: [
            { id: 'i_salary', name: 'Primary Salary', type: 'income', color: '#2B4C3B' },
            { id: 'e_mortgage', name: 'Mortgage & Utilities', type: 'expense', budget: 2500, color: '#111111' },
            { id: 'e_auto', name: 'EV Charging & Auto', type: 'expense', budget: 150, color: '#A63D2F' },
            { id: 'e_pet', name: 'Pipers Care', type: 'expense', budget: 150, color: '#D99A5A' },
            { id: 'e_tech', name: 'Home Lab & Tech', type: 'expense', budget: 150, color: '#7A8B76' }
        ],
        wallets: [{ id: 'w_chk', name: 'Checking Account' }],
        recurring: [],
        lastProcessed: Date.now()
    };
}

function buildMetadata() {
    return {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: currentUser.uid,
        createdByEmail: normalizeEmail(currentUser.email)
    };
}

function updateMetadata() {
    return {
        updatedAt: Date.now(),
        updatedBy: currentUser.uid,
        updatedByEmail: normalizeEmail(currentUser.email)
    };
}

let heartbeatTimer = null;
let heartbeatLastWrite = 0;

function safeCount(value, max) {
    const num = Number(value || 0);

    if (!Number.isFinite(num)) {
        return 0;
    }

    return Math.max(0, Math.min(Math.trunc(num), max));
}

async function writeUsageHeartbeat(force = false) {
    if (!currentUser) return;

    const now = Date.now();

    if (!force && now - heartbeatLastWrite < 60000) {
        return;
    }

    heartbeatLastWrite = now;

    const memberCount = Array.isArray(household?.allowedEmails)
        ? household.allowedEmails.length
        : 1;

    const payload = {
        lastActiveAt: now,
        updatedAt: now,
        appVersion: APP_VERSION,
        transactionCount: safeCount(transactions.length, 50000),
        goalCount: safeCount(goals.length, 1000),
        categoryCount: safeCount(categories.length, 500),
        isHouseholdOwner: Boolean(household && household.ownerUid === currentUser.uid),
        householdMemberCount: safeCount(memberCount, 20)
    };

    try {
        await setDoc(doc(db, `usageHeartbeats/${currentUser.uid}`), payload, { merge: true });
    } catch (error) {
        console.warn('Usage heartbeat failed:', error);
    }
}

function scheduleUsageHeartbeat(force = false) {
    if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
    }

    heartbeatTimer = setTimeout(() => {
        writeUsageHeartbeat(force);
    }, force ? 100 : 1500);
}

async function login() {
    const btn = $('loginBtn');

    try {
        btn.disabled = true;
        btn.textContent = 'Opening Google...';

        await signInWithRedirect(auth, provider);
    } catch (error) {
        console.error('Google redirect sign-in failed:', error);

        alert(
            `Google sign-in failed.\n\n` +
            `Code: ${error.code || 'unknown'}\n\n` +
            `${error.message || error}`
        );

        btn.disabled = false;
        btn.textContent = 'Sign in with Google';
    }
}

async function logout() {
    await signOut(auth);
}

async function resolveHousehold(user) {
    const email = normalizeEmail(user.email);
    const profileRef = doc(db, `userProfiles/${user.uid}`);
    const profileSnap = await getDoc(profileRef);

    if (profileSnap.exists() && profileSnap.data().activeHouseholdId) {
        return profileSnap.data().activeHouseholdId;
    }

    const householdsQuery = query(
        collection(db, 'households'),
        where('allowedEmails', 'array-contains', email)
    );

    const householdMatches = await getDocs(householdsQuery);

    if (!householdMatches.empty) {
        const existingHouseholdId = householdMatches.docs[0].id;

        await setDoc(profileRef, {
            email,
            activeHouseholdId: existingHouseholdId,
            updatedAt: Date.now()
        }, { merge: true });

        return existingHouseholdId;
    }

    const newHouseholdId = `h_${user.uid}`;

    await setDoc(doc(db, `households/${newHouseholdId}`), {
        ownerUid: user.uid,
        ownerEmail: email,
        allowedEmails: [email],
        name: 'Household Ledger',
        createdAt: Date.now(),
        updatedAt: Date.now()
    });

    await setDoc(profileRef, {
        email,
        activeHouseholdId: newHouseholdId,
        updatedAt: Date.now()
    }, { merge: true });

    await migrateLegacyUserData(user.uid, newHouseholdId);

    return newHouseholdId;
}

function sanitizeCategoryArray(rawCategories) {
    if (!Array.isArray(rawCategories)) return defaultSettings().categories;

    return rawCategories.slice(0, 100).map((cat, index) => {
        const safeType = allowedTypes.has(cat.type) && cat.type !== 'savings' ? cat.type : 'expense';
        const safeName = getSafePlainText(cat.name, 80) || 'Category';

        return {
            id: safeText(cat.id || `${safeType}_${Date.now()}_${index}`, 80),
            name: safeName,
            type: safeType,
            budget: validNonNegative(cat.budget ?? 0) ?? 0,
            color: safeColor(cat.color)
        };
    });
}

function sanitizeWalletArray(rawWallets) {
    if (!Array.isArray(rawWallets)) return defaultSettings().wallets;

    return rawWallets.slice(0, 50).map((wallet, index) => ({
        id: safeText(wallet.id || `w_${Date.now()}_${index}`, 80),
        name: getSafePlainText(wallet.name, 80) || 'Wallet'
    }));
}

function sanitizeRecurringArray(rawRecurring) {
    if (!Array.isArray(rawRecurring)) return [];

    return rawRecurring.slice(0, 50).map((rule, index) => ({
        id: safeText(rule.id || `r_${Date.now()}_${index}`, 80),
        type: allowedTypes.has(rule.type) ? rule.type : 'expense',
        amt: validAmount(rule.amt) || 0.01,
        note: getSafePlainText(rule.note, 80) || 'Recurring',
        catId: safeText(rule.catId || '', 80),
        goalId: safeText(rule.goalId || '', 80),
        walletId: safeText(rule.walletId || 'Auto', 80),
        intervalDays: validInterval(rule.intervalDays) || 30,
        lastTriggered: Number(rule.lastTriggered || Date.now())
    }));
}

async function migrateLegacyUserData(uid, householdId) {
    const settingsRef = doc(db, `households/${householdId}/settings/data`);
    const newSettingsSnap = await getDoc(settingsRef);

    if (!newSettingsSnap.exists()) {
        const legacySettingsSnap = await getDoc(doc(db, `users/${uid}/settings/data`));

        if (legacySettingsSnap.exists()) {
            const legacy = legacySettingsSnap.data();

            await setDoc(settingsRef, {
                categories: sanitizeCategoryArray(legacy.categories),
                wallets: sanitizeWalletArray(legacy.wallets),
                recurring: sanitizeRecurringArray(legacy.recurring),
                lastProcessed: Number(legacy.lastProcessed || Date.now()),
                ...buildMetadata()
            }, { merge: true });
        } else {
            await setDoc(settingsRef, {
                ...defaultSettings(),
                ...buildMetadata()
            }, { merge: true });
        }
    }

    const legacyTxsSnap = await getDocs(collection(db, `users/${uid}/transactions`));

    if (!legacyTxsSnap.empty) {
        const newTxsSnap = await getDocs(collection(db, `households/${householdId}/transactions`));

        if (newTxsSnap.empty) {
            for (const oldDoc of legacyTxsSnap.docs) {
                const old = oldDoc.data();
                const oldType = allowedTypes.has(old.type) ? old.type : 'expense';
                const oldAmt = validAmount(old.amt) || 0.01;
                const oldNote = getSafePlainText(old.note || 'Migrated transaction', 120) || 'Migrated transaction';

                const payload = {
                    type: oldType,
                    amt: oldAmt,
                    note: oldNote,
                    date: safeText(old.date || 'Migrated', 32),
                    timestamp: Number(old.timestamp || Date.now()),
                    walletId: safeText(old.walletId || 'Migrated', 80),
                    ...buildMetadata(),
                    migratedFrom: uid,
                    migratedAt: Date.now()
                };

                if (oldType === 'savings') {
                    payload.goalId = safeText(old.goalId || '', 80);
                } else {
                    payload.catId = safeText(old.catId || '', 80);
                }

                await addDoc(collection(db, `households/${householdId}/transactions`), payload);
            }
        }
    }
}

async function ensureDefaultGoal(householdId) {
    const goalsSnap = await getDocs(collection(db, `households/${householdId}/goals`));

    if (goalsSnap.empty) {
        await addDoc(collection(db, `households/${householdId}/goals`), {
            name: 'Kakinada India Trip',
            amount: 5000,
            monthly: 300,
            ...buildMetadata()
        });
    }
}

function initCloudSync(householdId) {
    unsubscribeHousehold = onSnapshot(doc(db, `households/${householdId}`), (snap) => {
        household = snap.exists() ? { id: snap.id, ...snap.data() } : null;
        renderHouseholdInfo();
        renderModalList();
    });

    unsubscribeSettings = onSnapshot(doc(db, `households/${householdId}/settings/data`), async (docSnap) => {
        if (docSnap.exists()) {
            const data = docSnap.data();

            categories = sanitizeCategoryArray(data.categories);
            wallets = sanitizeWalletArray(data.wallets);
            recurring = sanitizeRecurringArray(data.recurring);

            const lastProcessed = Number(data.lastProcessed || 0);
            const now = Date.now();

            if (now - lastProcessed > 43200000) {
                await processRecurringCloudItems(householdId, recurring);
                await setDoc(doc(db, `households/${householdId}/settings/data`), {
                    categories,
                    wallets,
                    recurring,
                    lastProcessed: now,
                    ...updateMetadata()
                }, { merge: true });
            }
        } else {
            await setDoc(doc(db, `households/${householdId}/settings/data`), {
                ...defaultSettings(),
                ...buildMetadata()
            }, { merge: true });
        }

        refreshDropdowns();
        renderUI();
        renderModalList();
    });

    unsubscribeGoals = onSnapshot(
        query(collection(db, `households/${householdId}/goals`), orderBy('createdAt', 'asc')),
        (snapshot) => {
            goals = [];
            snapshot.forEach((d) => {
                const g = d.data();
                goals.push({
                    id: d.id,
                    ...g,
                    name: getSafePlainText(g.name, 60) || 'Goal'
                });
            });
            refreshDropdowns();
            renderUI();
        }
    );

    unsubscribeTxs = onSnapshot(
        query(collection(db, `households/${householdId}/transactions`), orderBy('timestamp', 'desc')),
        (snapshot) => {
            transactions = [];
            snapshot.forEach((d) => transactions.push({ id: d.id, ...d.data() }));
            renderUI();
        }
    );
}

async function processRecurringCloudItems(householdId, rules) {
    if (!Array.isArray(rules) || rules.length === 0) return;

    const txsRef = collection(db, `households/${householdId}/transactions`);
    const now = Date.now();
    let updatesNeeded = false;

    for (const rule of rules) {
        const intervalDays = validInterval(rule.intervalDays);
        if (!intervalDays) continue;

        const lastTriggered = Number(rule.lastTriggered || 0);
        const msPerInterval = intervalDays * 86400000;

        if (now - lastTriggered >= msPerInterval) {
            const ruleType = allowedTypes.has(rule.type) ? rule.type : 'expense';
            const amt = validAmount(rule.amt);
            const safeNote = getSafePlainText(rule.note || 'Recurring', 80);

            if (!amt || !safeNote) continue;

            const payload = {
                type: ruleType,
                amt,
                note: `Auto ${safeNote}`,
                walletId: safeText(rule.walletId || 'Auto', 80),
                date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                timestamp: now,
                isAuto: true,
                ...buildMetadata()
            };

            if (ruleType === 'savings') {
                payload.goalId = safeText(rule.goalId, 80);
                if (!payload.goalId) continue;
            } else {
                payload.catId = safeText(rule.catId, 80);
                if (!payload.catId) continue;
            }

            await addDoc(txsRef, payload);
            rule.lastTriggered = now;
            updatesNeeded = true;
        }
    }

    if (updatesNeeded) {
        await setDoc(doc(db, `households/${householdId}/settings/data`), {
            categories,
            wallets,
            recurring,
            ...updateMetadata()
        }, { merge: true });
    }
}

function saveSettingsToCloud() {
    if (!activeHouseholdId) return;

    setDoc(doc(db, `households/${activeHouseholdId}/settings/data`), {
        categories,
        wallets,
        recurring,
        lastProcessed: Date.now(),
        ...updateMetadata()
    }, { merge: true });
}

function setType(newType) {
    if (!allowedTypes.has(newType)) return;

    type = newType;

    $('btnExpense').classList.toggle('active', newType === 'expense');
    $('btnIncome').classList.toggle('active', newType === 'income');
    $('btnSavings').classList.toggle('active', newType === 'savings');

    setHidden($('catRow'), newType === 'savings');
    setHidden($('goalRow'), newType !== 'savings');

    $('catLabel').textContent = newType === 'income' ? 'Source' : 'Envelope';
    $('quickTags').classList.toggle('hidden', newType !== 'expense');
    setHidden($('walletRow'), newType === 'income');

    refreshDropdowns();
}

function quickFill(catId) {
    setType('expense');
    $('catInput').value = catId;
    $('amtInput').focus();
}

async function saveTx() {
    if (!activeHouseholdId) {
        alert('Ledger is not ready yet.');
        return;
    }

    const rawAmount = $('amtInput').value;
    const rawNote = $('noteInput').value;

    const amt = validAmount(rawAmount);
    const note = getSafePlainText(rawNote, 120);

    if (!amt) {
        alert('Amount can only use digits, one optional $, and one optional decimal point.');
        return;
    }

    if (!note) {
        alert('Note rejected. Use only letters, numbers, spaces, and approved punctuation.');
        return;
    }

    const txPayload = {
        type,
        amt,
        note,
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        timestamp: Date.now(),
        ...buildMetadata()
    };

    if (type === 'income') {
        txPayload.catId = safeText($('catInput').value, 80);
        txPayload.walletId = 'Deposit';
    } else if (type === 'expense') {
        txPayload.catId = safeText($('catInput').value, 80);
        txPayload.walletId = safeText($('walletInput').value, 80);
    } else if (type === 'savings') {
        txPayload.goalId = safeText($('goalInput').value, 80);
        txPayload.walletId = safeText($('walletInput').value, 80);

        if (!txPayload.goalId) {
            alert('Create a savings goal first.');
            return;
        }
    }

    $('saveTxBtn').disabled = true;
    $('saveTxBtn').textContent = 'Saving...';

    try {
        await addDoc(collection(db, `households/${activeHouseholdId}/transactions`), txPayload);

        $('amtInput').value = '';
        $('noteInput').value = '';
        document.activeElement.blur();
    } catch (error) {
        console.error(error);
        alert('Transaction rejected by security rules.');
    } finally {
        $('saveTxBtn').disabled = false;
        $('saveTxBtn').textContent = 'Log Transaction';
    }
}

async function delTx(id) {
    if (!activeHouseholdId || !id) return;

    if (confirm('Delete this transaction?')) {
        await deleteDoc(doc(db, `households/${activeHouseholdId}/transactions/${id}`));
    }
}

function openCatModal() {
    setHidden($('categoryModal'), false);
    setModalTab('expense');
}

function closeCatModal() {
    setHidden($('categoryModal'), true);
    cancelEdit();
}

function setModalTab(newTab) {
    const tabs = ['expense', 'income', 'wallet', 'recurring', 'household'];
    if (!tabs.includes(newTab)) return;

    modalTab = newTab;

    const buttonMap = {
        expense: $('modalBtnExpense'),
        income: $('modalBtnIncome'),
        wallet: $('modalBtnWallet'),
        recurring: $('modalBtnRecurring'),
        household: $('modalBtnHousehold')
    };

    Object.entries(buttonMap).forEach(([key, button]) => {
        button.classList.toggle('active', key === newTab);
    });

    setHidden($('modalBudgetRow'), newTab !== 'expense');
    setHidden($('modalRecurringInputs'), newTab !== 'recurring');
    setHidden($('householdHelp'), newTab !== 'household');

    const labelMap = {
        expense: 'Name',
        income: 'Name',
        wallet: 'Wallet Name',
        recurring: 'Memo',
        household: 'Add Email'
    };

    const placeholderMap = {
        expense: 'e.g., Groceries',
        income: 'e.g., Paycheck',
        wallet: 'e.g., Chase Card',
        recurring: 'e.g., Paycheck',
        household: 'name@example.com'
    };

    const titleMap = {
        expense: 'Current Expenses',
        income: 'Income Sources',
        wallet: 'Your Wallets',
        recurring: 'Automations',
        household: 'Household Access'
    };

    $('modalNameLabel').textContent = labelMap[newTab];
    $('newCatName').placeholder = placeholderMap[newTab];

    $('newCatName').dataset.validate = newTab === 'household' ? 'email' : 'text';

    $('modalListTitle').textContent = titleMap[newTab];

    cancelEdit(false);
    renderModalList();
}

function cancelEdit(render = true) {
    editingItemId = null;

    $('newCatName').value = '';
    $('newCatBudget').value = '';
    $('recAmt').value = '';
    $('recInterval').value = '14';

    $('saveSetupBtn').textContent = modalTab === 'household' ? 'Add Member' : 'Save Item';
    setHidden($('cancelEditBtn'), true);

    if (render) renderModalList();
}

async function saveSetupItem() {
    const name = modalTab === 'household'
        ? validateEmail($('newCatName').value)
        : getSafePlainText($('newCatName').value, 80);

    if (!name) {
        alert(
            modalTab === 'household'
                ? 'Enter a valid email address.'
                : 'Name rejected. Use only letters, numbers, spaces, and approved punctuation.'
        );
        return;
    }

    if (modalTab === 'household') {
        await addHouseholdMember(name);
        return;
    }

    const budgetRaw = $('newCatBudget').value || '$0';
    const budget = validNonNegative(budgetRaw);

    if (budget === null) {
        alert('Budget can only use digits, one optional $, and one optional decimal point.');
        return;
    }

    if (modalTab === 'recurring') {
        const amt = validAmount($('recAmt').value);
        const rType = $('recType').value;
        const intervalDays = validInterval($('recInterval').value);

        if (!amt) {
            alert('Amount can only use digits, one optional $, and one optional decimal point.');
            return;
        }

        if (!allowedTypes.has(rType)) {
            alert('Invalid recurring type.');
            return;
        }

        if (!intervalDays) {
            alert('Interval must be a whole number from 1 to 365.');
            return;
        }

        const rule = {
            id: `r_${Date.now()}`,
            type: rType,
            amt,
            note: name,
            intervalDays,
            lastTriggered: Date.now()
        };

        if (rType === 'savings') {
            rule.goalId = safeText($('recGoal').value, 80);
            rule.walletId = safeText($('walletInput').value || 'Auto', 80);

            if (!rule.goalId) {
                alert('Create a savings goal first.');
                return;
            }
        } else {
            rule.catId = safeText($('recCat').value, 80);
            rule.walletId = 'Auto';

            if (!rule.catId) {
                alert('Create a category first.');
                return;
            }
        }

        recurring.push(rule);
    } else if (editingItemId) {
        if (modalTab === 'wallet') {
            const wallet = wallets.find(w => w.id === editingItemId);
            if (wallet) wallet.name = name;
        } else {
            const cat = categories.find(c => c.id === editingItemId);
            if (cat) {
                cat.name = name;
                cat.budget = modalTab === 'expense' ? budget : 0;
            }
        }
    } else {
        if (modalTab === 'wallet') {
            wallets.push({ id: `w_${Date.now()}`, name });
        } else {
            categories.push({
                id: `${modalTab === 'expense' ? 'e' : 'i'}_${Date.now()}`,
                name,
                type: modalTab,
                budget: modalTab === 'expense' ? budget : 0,
                color: palette[categories.length % palette.length]
            });
        }
    }

    saveSettingsToCloud();
    cancelEdit();
    renderModalList();
}

function editItem(id) {
    editingItemId = id;

    if (modalTab === 'wallet') {
        const item = wallets.find(w => w.id === id);
        if (!item) return;
        $('newCatName').value = item.name || '';
    } else {
        const item = categories.find(c => c.id === id);
        if (!item) return;
        $('newCatName').value = item.name || '';
        $('newCatBudget').value = item.budget || '';
    }

    $('saveSetupBtn').textContent = 'Update Item';
    setHidden($('cancelEditBtn'), false);
}

function deleteItem(id) {
    if (!confirm('Delete this?')) return;

    if (modalTab === 'wallet') {
        wallets = wallets.filter(w => w.id !== id);
    } else if (modalTab === 'recurring') {
        recurring = recurring.filter(r => r.id !== id);
    } else {
        categories = categories.filter(c => c.id !== id);
    }

    if (editingItemId === id) cancelEdit();
    saveSettingsToCloud();
    renderModalList();
}

async function addHouseholdMember(rawEmail) {
    if (!activeHouseholdId || !household) {
        alert('Household not ready.');
        return;
    }

    if (household.ownerUid !== currentUser.uid) {
        alert('Only the household owner can add members.');
        return;
    }

    const email = validateEmail(rawEmail);

    if (!email) {
        alert('Enter a valid email address.');
        return;
    }

    const allowedEmails = Array.from(new Set([...(household.allowedEmails || []), email]));

    if (allowedEmails.length > 5) {
        alert('Household member limit reached.');
        return;
    }

    try {
        await setDoc(doc(db, `households/${activeHouseholdId}`), {
            allowedEmails,
            updatedAt: Date.now()
        }, { merge: true });

        $('newCatName').value = '';
        alert(`${email} can now access this household ledger.`);
    } catch (error) {
        console.error(error);
        alert('Household update rejected by security rules.');
    }
}

async function removeHouseholdMember(email) {
    if (!activeHouseholdId || !household) return;

    if (household.ownerUid !== currentUser.uid) {
        alert('Only the household owner can remove members.');
        return;
    }

    const normalized = normalizeEmail(email);
    const currentEmail = normalizeEmail(currentUser.email);

    if (normalized === currentEmail) {
        alert('You cannot remove yourself from your own household.');
        return;
    }

    if (!confirm(`Remove ${normalized} from this household?`)) return;

    const allowedEmails = (household.allowedEmails || []).filter(e => normalizeEmail(e) !== normalized);

    await setDoc(doc(db, `households/${activeHouseholdId}`), {
        allowedEmails,
        updatedAt: Date.now()
    }, { merge: true });
}

function refreshDropdowns() {
    replaceOptions($('catInput'), categories.filter(c => c.type === type), 'name');
    replaceOptions($('walletInput'), wallets, 'name');
    replaceOptions($('goalInput'), goals, 'name');
    replaceOptions($('recCat'), categories, 'name');
    replaceOptions($('recGoal'), goals, 'name');
}

function replaceOptions(select, items, labelKey) {
    if (!select) return;

    select.replaceChildren();

    items.forEach(item => {
        const option = document.createElement('option');
        option.value = String(item.id || '');
        option.textContent = safeText(item[labelKey] || 'Unnamed', 80);
        select.appendChild(option);
    });
}

function onRecurringTypeChange() {
    const rType = $('recType').value;
    setHidden($('recCatRow'), rType === 'savings');
    setHidden($('recGoalRow'), rType !== 'savings');
}

function renderHouseholdInfo() {
    if (!household) {
        $('householdBadge').textContent = '';
        return;
    }

    const count = Array.isArray(household.allowedEmails) ? household.allowedEmails.length : 1;
    $('householdBadge').textContent = count > 1 ? `${count} household members` : 'Solo household';
}

function renderModalList() {
    const list = $('modalSetupList');
    list.replaceChildren();

    if (modalTab === 'wallet') {
        wallets.forEach(wallet => {
            list.appendChild(rowWithActions(wallet.name, '', [
                { label: '✎', className: 'edit-btn', action: () => editItem(wallet.id) },
                { label: '×', className: 'del-btn', action: () => deleteItem(wallet.id) }
            ]));
        });
    } else if (modalTab === 'recurring') {
        recurring.forEach(rule => {
            const goal = goals.find(g => g.id === rule.goalId);
            const cat = categories.find(c => c.id === rule.catId);
            const meta = `${rule.type || 'unknown'} • Every ${rule.intervalDays || 0} days${goal ? ` • ${goal.name}` : ''}${cat ? ` • ${cat.name}` : ''}`;

            list.appendChild(rowWithActions(`${rule.note || 'Recurring'} (${money2(rule.amt)})`, meta, [
                { label: '×', className: 'del-btn', action: () => deleteItem(rule.id) }
            ]));
        });
    } else if (modalTab === 'household') {
        const isOwner = household && household.ownerUid === currentUser?.uid;
        const emails = Array.isArray(household?.allowedEmails) ? household.allowedEmails : [];

        const intro = createEl('div', 'small-muted');
        intro.textContent = isOwner
            ? 'You can add or remove household members.'
            : 'Only the household owner can add or remove household members.';

        const introRow = createEl('div', 'list-row');
        introRow.appendChild(intro);
        list.appendChild(introRow);

        emails.forEach(email => {
            const actions = [];

            if (isOwner && normalizeEmail(email) !== normalizeEmail(currentUser?.email)) {
                actions.push({ label: '×', className: 'del-btn', action: () => removeHouseholdMember(email) });
            }

            const role = normalizeEmail(email) === normalizeEmail(household?.ownerEmail) ? 'Owner' : 'Member';
            list.appendChild(rowWithActions(email, role, actions));
        });
    } else {
        categories.filter(c => c.type === modalTab).forEach(cat => {
            const meta = modalTab === 'expense' ? `Limit: ${money(cat.budget)}` : '';
            const row = rowWithActions(cat.name, meta, [
                { label: '✎', className: 'edit-btn', action: () => editItem(cat.id) },
                { label: '×', className: 'del-btn', action: () => deleteItem(cat.id) }
            ], safeColor(cat.color));

            list.appendChild(row);
        });
    }

    if (!list.childNodes.length) {
        const empty = createEl('div', 'list-row');
        empty.appendChild(createEl('div', 'small-muted', 'No items found.'));
        list.appendChild(empty);
    }
}

function rowWithActions(title, meta, actions = [], dotColor = '') {
    const row = createEl('div', 'list-row');

    const main = createEl('div', 'list-main');
    const name = createEl('div', 'env-name');

    if (dotColor) {
        const dot = createEl('span', 'color-dot');
        dot.style.backgroundColor = safeColor(dotColor);
        name.appendChild(dot);
    }

    name.appendChild(document.createTextNode(safeText(title, 120)));
    main.appendChild(name);

    if (meta) {
        main.appendChild(createEl('div', 'tx-meta', safeText(meta, 160)));
    }

    row.appendChild(main);

    if (actions.length) {
        const actionWrap = createEl('div', 'action-btns');

        actions.forEach(action => {
            const btn = createEl('button', action.className, action.label);
            btn.type = 'button';
            btn.addEventListener('click', action.action);
            actionWrap.appendChild(btn);
        });

        row.appendChild(actionWrap);
    }

    return row;
}

/* Activity search, filters, sorting */

function activityEl(id) {
    return document.getElementById(id);
}

function normalizeSearch(value) {
    return String(value || '').toLowerCase().trim();
}

function txTime(tx) {
    return Number(tx.timestamp || 0);
}

function txAmount(tx) {
    return Number(tx.amt || 0);
}

function getTxCategoryName(tx) {
    if (tx.type === 'savings') {
        const goal = goals.find(g => g.id === tx.goalId);
        return goal ? goal.name : (tx.goalId || 'Savings Goal');
    }

    const category = categories.find(c => c.id === tx.catId);
    return category ? category.name : (tx.catId || 'Uncategorized');
}

function getTxWalletName(tx) {
    if (tx.type === 'income') return 'Deposit';

    const wallet = wallets.find(w => w.id === tx.walletId);
    return wallet ? wallet.name : (tx.walletId || 'Wallet');
}

function monthKeyFromTimestamp(timestamp) {
    const date = new Date(Number(timestamp || 0));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabelFromTimestamp(timestamp) {
    const date = new Date(Number(timestamp || 0));
    return date.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric'
    });
}

function getActivityDateRange() {
    const preset = activityEl('activityDatePreset')?.value || 'month';
    const now = new Date();

    let start = null;
    let end = null;

    if (preset === 'month') {
        start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    }

    if (preset === 'lastMonth') {
        start = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
        end = new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1;
    }

    if (preset === 'last3') {
        start = new Date(now.getFullYear(), now.getMonth() - 2, 1).getTime();
    }

    if (preset === 'year') {
        start = new Date(now.getFullYear(), 0, 1).getTime();
    }

    if (preset === 'custom') {
        const startInput = activityEl('activityStartDate')?.value;
        const endInput = activityEl('activityEndDate')?.value;

        if (startInput) {
            start = new Date(`${startInput}T00:00:00`).getTime();
        }

        if (endInput) {
            end = new Date(`${endInput}T23:59:59`).getTime();
        }
    }

    return { start, end };
}

function populateActivityFilterOptions() {
    const categorySelect = activityEl('activityCategoryFilter');
    const walletSelect = activityEl('activityWalletFilter');

    if (!categorySelect || !walletSelect) return;

    const selectedCategory = categorySelect.value || 'all';
    const selectedWallet = walletSelect.value || 'all';

    const categoryOptions = new Map();

    categories.forEach(cat => {
        if (cat && cat.id) {
            categoryOptions.set(cat.id, cat.name || cat.id);
        }
    });

    transactions.forEach(tx => {
        if (tx.type === 'savings') return;

        if (tx.catId && !categoryOptions.has(tx.catId)) {
            categoryOptions.set(tx.catId, tx.catId);
        }
    });

    const walletOptions = new Map();

    if (transactions.some(tx => tx.walletId === 'Deposit' || tx.type === 'income')) {
        walletOptions.set('Deposit', 'Deposit');
    }

    wallets.forEach(wallet => {
        if (wallet && wallet.id) {
            walletOptions.set(wallet.id, wallet.name || wallet.id);
        }
    });

    transactions.forEach(tx => {
        if (tx.walletId && !walletOptions.has(tx.walletId)) {
            walletOptions.set(tx.walletId, tx.walletId);
        }
    });

    categorySelect.replaceChildren();
    walletSelect.replaceChildren();

    const allCat = document.createElement('option');
    allCat.value = 'all';
    allCat.textContent = 'All Categories';
    categorySelect.appendChild(allCat);

    [...categoryOptions.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .forEach(([id, name]) => {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = safeText(name, 80);
            categorySelect.appendChild(option);
        });

    const savingsOption = document.createElement('option');
    savingsOption.value = '__savings__';
    savingsOption.textContent = 'Savings Goals';
    categorySelect.appendChild(savingsOption);

    const allWallet = document.createElement('option');
    allWallet.value = 'all';
    allWallet.textContent = 'All Wallets';
    walletSelect.appendChild(allWallet);

    [...walletOptions.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .forEach(([id, name]) => {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = safeText(name, 80);
            walletSelect.appendChild(option);
        });

    if ([...categorySelect.options].some(option => option.value === selectedCategory)) {
        categorySelect.value = selectedCategory;
    }

    if ([...walletSelect.options].some(option => option.value === selectedWallet)) {
        walletSelect.value = selectedWallet;
    }
}

function getFilteredActivityTransactions() {
    const search = normalizeSearch(activityEl('activitySearch')?.value);
    const typeFilter = activityEl('activityTypeFilter')?.value || 'all';
    const categoryFilter = activityEl('activityCategoryFilter')?.value || 'all';
    const walletFilter = activityEl('activityWalletFilter')?.value || 'all';
    const sort = activityEl('activitySort')?.value || 'newest';
    const { start, end } = getActivityDateRange();

    let filtered = [...transactions];

    filtered = filtered.filter(tx => {
        const time = txTime(tx);

        if (start !== null && time < start) return false;
        if (end !== null && time > end) return false;

        if (typeFilter !== 'all' && tx.type !== typeFilter) return false;

        if (categoryFilter !== 'all') {
            if (categoryFilter === '__savings__') {
                if (tx.type !== 'savings') return false;
            } else if (tx.catId !== categoryFilter) {
                return false;
            }
        }

        if (walletFilter !== 'all' && tx.walletId !== walletFilter) return false;

        if (search) {
            const searchable = [
                tx.note,
                tx.type,
                tx.amt,
                tx.date,
                getTxCategoryName(tx),
                getTxWalletName(tx),
                tx.catId,
                tx.walletId,
                tx.goalId
            ].map(normalizeSearch).join(' ');

            if (!searchable.includes(search)) return false;
        }

        return true;
    });

    filtered.sort((a, b) => {
        if (sort === 'oldest') return txTime(a) - txTime(b);
        if (sort === 'highest') return txAmount(b) - txAmount(a);
        if (sort === 'lowest') return txAmount(a) - txAmount(b);

        if (sort === 'az') {
            const aText = `${a.note || ''} ${getTxCategoryName(a)}`;
            const bText = `${b.note || ''} ${getTxCategoryName(b)}`;
            return aText.localeCompare(bText);
        }

        return txTime(b) - txTime(a);
    });

    return filtered;
}

function createActivityStat(label, value) {
    const box = createEl('div', 'activity-stat');

    const labelEl = createEl('span', '', label);
    const valueEl = createEl('strong', '', value);

    box.append(labelEl, valueEl);
    return box;
}

function renderActivityFilterSummary(filteredTxs) {
    const summary = activityEl('activityFilterSummary');
    if (!summary) return;

    const income = filteredTxs
        .filter(tx => tx.type === 'income')
        .reduce((sum, tx) => sum + txAmount(tx), 0);

    const expenses = filteredTxs
        .filter(tx => tx.type === 'expense')
        .reduce((sum, tx) => sum + txAmount(tx), 0);

    const savings = filteredTxs
        .filter(tx => tx.type === 'savings')
        .reduce((sum, tx) => sum + txAmount(tx), 0);

    const net = income - expenses - savings;

    summary.replaceChildren(
        createActivityStat('Showing', `${filteredTxs.length} transaction${filteredTxs.length === 1 ? '' : 's'}`),
        createActivityStat('Income', money2(income)),
        createActivityStat('Expenses', money2(expenses)),
        createActivityStat('Savings', money2(savings)),
        createActivityStat('Net', money2(net))
    );
}

function createActivityTransactionRow(t) {
    const cat = categories.find(c => c.id === t.catId);
    const wallet = wallets.find(w => w.id === t.walletId);
    const goal = goals.find(g => g.id === t.goalId);

    const isIncome = t.type === 'income';
    const isSavings = t.type === 'savings';

    const label = isSavings
        ? goal ? goal.name : 'Savings'
        : cat ? cat.name : 'Uncategorized';

    const amountLabel = isIncome
        ? `+${money2(t.amt)}`
        : isSavings
            ? `→ ${money2(t.amt)}`
            : `-${money2(t.amt)}`;

    const amountClass = isIncome
        ? 'tx-amt income'
        : isSavings
            ? 'tx-amt savings'
            : 'tx-amt expense';

    const row = createEl('div', 'list-row activity-row');

    const main = createEl('div', 'list-main');
    main.appendChild(createEl('div', 'tx-desc', filterPlainTextForDisplay(t.note || 'Untitled transaction', 120)));

    const meta = createEl('div', 'tx-meta');
    meta.textContent = `${safeText(t.date || '', 32)} • ${safeText(label, 80)}`;

    if (!isIncome && wallet && wallet.name !== 'Deposit') {
        const pill = createEl('span', 'pill', wallet.name);
        meta.appendChild(pill);
    }

    main.appendChild(meta);

    const actionWrap = createEl('div', 'action-btns');
    const amount = createEl('div', amountClass, amountLabel);
    const del = createEl('button', 'del-btn', '×');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete transaction');
    del.addEventListener('click', () => delTx(t.id));

    actionWrap.appendChild(amount);
    actionWrap.appendChild(del);

    row.appendChild(main);
    row.appendChild(actionWrap);

    return row;
}

function resetActivityFilters() {
    if (activityEl('activitySearch')) activityEl('activitySearch').value = '';
    if (activityEl('activityDatePreset')) activityEl('activityDatePreset').value = 'month';
    if (activityEl('activityTypeFilter')) activityEl('activityTypeFilter').value = 'all';
    if (activityEl('activityCategoryFilter')) activityEl('activityCategoryFilter').value = 'all';
    if (activityEl('activityWalletFilter')) activityEl('activityWalletFilter').value = 'all';
    if (activityEl('activitySort')) activityEl('activitySort').value = 'newest';
    if (activityEl('activityStartDate')) activityEl('activityStartDate').value = '';
    if (activityEl('activityEndDate')) activityEl('activityEndDate').value = '';
    if (activityEl('activityGroupByMonth')) activityEl('activityGroupByMonth').checked = false;

    toggleActivityCustomDates();
    renderTransactions();
}

function toggleActivityCustomDates() {
    const customDates = activityEl('activityCustomDates');
    const preset = activityEl('activityDatePreset')?.value;

    if (customDates) {
        customDates.hidden = preset !== 'custom';
    }
}

function bindActivityFilters() {
    if (activityFiltersBound) return;
    activityFiltersBound = true;

    [
        'activitySearch',
        'activityDatePreset',
        'activityTypeFilter',
        'activityCategoryFilter',
        'activityWalletFilter',
        'activitySort',
        'activityStartDate',
        'activityEndDate',
        'activityGroupByMonth'
    ].forEach(id => {
        const element = activityEl(id);
        if (!element) return;

        const eventName = element.type === 'search' || element.type === 'text'
            ? 'input'
            : 'change';

        element.addEventListener(eventName, () => {
            if (id === 'activityDatePreset') {
                toggleActivityCustomDates();
            }

            renderTransactions();
        });
    });

    const resetBtn = activityEl('activityResetFilters');
    if (resetBtn) {
        resetBtn.addEventListener('click', resetActivityFilters);
    }

    toggleActivityCustomDates();
}

function renderUI() {
    const timeFilter = $('timeFilter').value;
    let activeTxs = transactions;

    if (timeFilter === 'month') {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        activeTxs = transactions.filter(t => Number(t.timestamp || 0) >= startOfMonth);
    }

    const totalInc = activeTxs.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amt || 0), 0);
    const totalExp = activeTxs.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amt || 0), 0);
    const totalSav = activeTxs.filter(t => t.type === 'savings').reduce((s, t) => s + Number(t.amt || 0), 0);
    const available = totalInc - totalExp - totalSav;

    $('lblBalance').textContent = money(available);
    $('lblTotalIn').textContent = money(totalInc);
    $('lblTotalOut').textContent = money(totalExp);
    $('lblTotalSaved').textContent = money(totalSav);

    const allocatedPct = totalInc > 0 ? Math.min(((totalExp + totalSav) / totalInc) * 100, 100) : 0;
    $('lblCorrPct').textContent = `${allocatedPct.toFixed(1)}%`;
    $('corrBar').style.width = `${allocatedPct}%`;

    renderPie(activeTxs, totalExp);
    renderQuickTags();
    renderExpenseBreakdown(activeTxs);
    renderSavingsList();
    renderTransactions();
}

function renderPie(activeTxs, totalExp) {
    let gradientStr = '';
    let currentPct = 0;

    categories.filter(c => c.type === 'expense').forEach(cat => {
        const spent = activeTxs
            .filter(t => t.catId === cat.id && t.type === 'expense')
            .reduce((s, t) => s + Number(t.amt || 0), 0);

        if (spent > 0 && totalExp > 0) {
            const slicePct = (spent / totalExp) * 100;
            gradientStr += `${safeColor(cat.color)} ${currentPct}% ${currentPct + slicePct}%, `;
            currentPct += slicePct;
        }
    });

    $('expensePie').style.background =
        totalExp === 0 || !gradientStr
            ? 'conic-gradient(#E2E0D8 0%)'
            : `conic-gradient(${gradientStr.slice(0, -2)})`;
}

function renderQuickTags() {
    const wrap = $('quickTags');
    wrap.replaceChildren();

    categories.filter(c => c.type === 'expense').slice(0, 6).forEach(cat => {
        const btn = createEl('button', 'tag', cat.name);
        btn.type = 'button';
        btn.addEventListener('click', () => quickFill(cat.id));
        wrap.appendChild(btn);
    });
}

function renderExpenseBreakdown(activeTxs) {
    const list = $('envList');
    list.replaceChildren();

    categories.filter(c => c.type === 'expense').forEach(cat => {
        const spent = activeTxs
            .filter(t => t.catId === cat.id && t.type === 'expense')
            .reduce((s, t) => s + Number(t.amt || 0), 0);

        const budget = Number(cat.budget || 0);
        const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;

        list.appendChild(progressRow(cat.name, `${money(spent)} / ${money(budget)}`, pct, safeColor(cat.color)));
    });

    if (!list.childNodes.length) {
        list.appendChild(emptyRow('No expense categories yet.'));
    }
}

function renderSavingsList() {
    const list = $('savingsList');
    list.replaceChildren();

    goals.forEach(goal => {
        const saved = transactions
            .filter(t => t.type === 'savings' && t.goalId === goal.id)
            .reduce((s, t) => s + Number(t.amt || 0), 0);

        const target = Number(goal.amount || 0);
        const pct = target > 0 ? Math.min((saved / target) * 100, 100) : 0;

        list.appendChild(progressRow(goal.name, `${money(saved)} / ${money(target)}`, pct, '#2B4C3B'));
    });

    if (!list.childNodes.length) {
        list.appendChild(emptyRow('No savings goals yet.'));
    }
}

function progressRow(name, stat, pct, color) {
    const row = createEl('div', 'list-row');

    const main = createEl('div', 'list-main');
    const title = createEl('div', 'env-name');

    const dot = createEl('span', 'color-dot');
    dot.style.backgroundColor = safeColor(color);

    title.appendChild(dot);
    title.appendChild(document.createTextNode(safeText(name, 80)));
    main.appendChild(title);

    const track = createEl('div', 'env-track');
    const fill = createEl('div', 'env-fill');
    fill.style.width = `${Math.max(0, Math.min(Number(pct || 0), 100))}%`;
    fill.style.backgroundColor = safeColor(color);
    track.appendChild(fill);
    main.appendChild(track);

    const stats = createEl('div', 'env-stats', stat);

    row.appendChild(main);
    row.appendChild(stats);

    return row;
}

function renderTransactions() {
    const list = $('txList');
    if (!list) return;

    populateActivityFilterOptions();

    const filteredTxs = getFilteredActivityTransactions();
    renderActivityFilterSummary(filteredTxs);

    list.replaceChildren();

    if (!filteredTxs.length) {
        list.appendChild(emptyRow('No transactions match these filters.'));
        return;
    }

    const groupByMonth = activityEl('activityGroupByMonth')?.checked;

    if (!groupByMonth) {
        filteredTxs.forEach(t => {
            list.appendChild(createActivityTransactionRow(t));
        });
        return;
    }

    let currentMonth = '';

    filteredTxs.forEach(t => {
        const monthKey = monthKeyFromTimestamp(txTime(t));

        if (monthKey !== currentMonth) {
            currentMonth = monthKey;

            const heading = createEl('div', 'activity-month-heading', monthLabelFromTimestamp(txTime(t)));
            list.appendChild(heading);
        }

        list.appendChild(createActivityTransactionRow(t));
    });
}

function emptyRow(message) {
    const row = createEl('div', 'list-row');
    row.appendChild(createEl('div', 'small-muted', message));
    return row;
}

function applyInputFilters() {
    document.querySelectorAll('[data-validate]').forEach(input => {
        input.addEventListener('input', () => {
            const kind = input.dataset.validate;

            if (kind === 'money') {
                input.value = filterMoneyInput(input.value);
            } else if (kind === 'integer') {
                input.value = filterIntegerInput(input.value);
            } else if (kind === 'email') {
                input.value = filterEmailInput(input.value);
            }

            // Important:
            // Do NOT auto-clean text fields.
            // Notes, category names, wallet names, and recurring memos
            // preserve what the user typed, then get rejected on Save
            // if illegal characters exist.
        });

        input.addEventListener('paste', () => {
            setTimeout(() => input.dispatchEvent(new Event('input')), 0);
        });
    });
}

function bindEvents() {
    $('loginBtn').addEventListener('click', login);
    $('logoutBtn').addEventListener('click', logout);
    $('saveTxBtn').addEventListener('click', saveTx);
    $('openSetupBtn').addEventListener('click', openCatModal);
    $('closeSetupBtn').addEventListener('click', closeCatModal);
    $('saveSetupBtn').addEventListener('click', saveSetupItem);
    $('cancelEditBtn').addEventListener('click', () => cancelEdit());
    $('timeFilter').addEventListener('change', renderUI);
    $('recType').addEventListener('change', onRecurringTypeChange);

    document.querySelectorAll('[data-type]').forEach(btn => {
        btn.addEventListener('click', () => setType(btn.dataset.type));
    });

    document.querySelectorAll('[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => setModalTab(btn.dataset.tab));
    });

    applyInputFilters();
    bindActivityFilters();
}

bindEvents();

getRedirectResult(auth).catch((error) => {
    console.error('Redirect result failed:', error);

    alert(
        `Google sign-in failed.\n\n` +
        `Code: ${error.code || 'unknown'}\n\n` +
        `${error.message || error}`
    );
});

onAuthStateChanged(auth, async (user) => {
    clearSubscriptions();

    if (user) {
        currentUser = user;
        setHidden($('loginScreen'), true);
        setHidden($('appScreen'), false);

        try {
            showLoading('Connecting household ledger...');
            activeHouseholdId = await resolveHousehold(user);
            await ensureDefaultGoal(activeHouseholdId);
            initCloudSync(activeHouseholdId);
        } catch (error) {
            console.error(error);
            alert(`Ledger failed to load: ${error.message}`);
        } finally {
            hideLoading();
        }
    } else {
        currentUser = null;
        activeHouseholdId = null;
        household = null;
        transactions = [];
        categories = [];
        wallets = [];
        recurring = [];
        goals = [];

        setHidden($('loginScreen'), false);
        setHidden($('appScreen'), true);
        hideLoading();
    }
});
