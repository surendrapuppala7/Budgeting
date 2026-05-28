import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    initializeAppCheck,
    ReCaptchaV3Provider
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
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
    authDomain: "ledger-d3ec5.firebaseapp.com",
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

let currentUser = null;
let activeHouseholdId = null;
let goals = [];
let transactions = [];
let unsubscribeGoals = null;
let unsubscribeTxs = null;
let editingGoalId = null;

const $ = (id) => document.getElementById(id);

const TEXT_PATTERN = /^[A-Za-z0-9 .,!?\-_()$#@&+%]*$/;
const ILLEGAL_TEXT_PATTERN = /[^A-Za-z0-9 .,!?\-_()$#@&+%]/;

function createEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function setHidden(node, hidden) {
    node.classList.toggle('hidden', Boolean(hidden));
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function cleanControlChars(value, max = 120) {
    return String(value || '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .trim()
        .slice(0, max);
}

function hasIllegalTextChars(value) {
    return ILLEGAL_TEXT_PATTERN.test(String(value || ''));
}

function filterPlainText(value, max = 120) {
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

    return Math.round(num);
}

function money(num) {
    return `$${Number(num || 0).toLocaleString()}`;
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
        const householdId = householdMatches.docs[0].id;

        await setDoc(profileRef, {
            email,
            activeHouseholdId: householdId,
            updatedAt: Date.now()
        }, { merge: true });

        return householdId;
    }

    window.location.href = 'index.html';
    return null;
}

function initGoalSync(householdId) {
    if (unsubscribeGoals) unsubscribeGoals();
    if (unsubscribeTxs) unsubscribeTxs();

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
            renderGoals();
        }
    );

    unsubscribeTxs = onSnapshot(
        query(collection(db, `households/${householdId}/transactions`), orderBy('timestamp', 'desc')),
        (snapshot) => {
            transactions = [];
            snapshot.forEach((d) => transactions.push({ id: d.id, ...d.data() }));
            renderGoals();
        }
    );
}

function getSavedForGoal(goalId) {
    return transactions
        .filter(t => t.type === 'savings' && t.goalId === goalId)
        .reduce((s, t) => s + Number(t.amt || 0), 0);
}

function projectionText(goal, monthlyOverride = null) {
    const saved = getSavedForGoal(goal.id);
    const target = Number(goal.amount || 0);
    const monthly = Number(monthlyOverride ?? goal.monthly ?? 0);
    const remaining = Math.max(target - saved, 0);

    if (remaining <= 0) return 'Funded';
    if (monthly <= 0) return 'Set monthly plan';

    const monthsNeeded = Math.ceil(remaining / monthly);
    const futureDate = new Date();
    futureDate.setMonth(futureDate.getMonth() + monthsNeeded);

    return futureDate.toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric'
    });
}

function renderGoals() {
    const container = $('goalsContainer');
    container.replaceChildren();

    if (!goals.length) {
        container.appendChild(createEl('p', 'muted', 'No goals yet. Create your first savings target.'));
        return;
    }

    goals.forEach(goal => {
        const saved = getSavedForGoal(goal.id);
        const target = Number(goal.amount || 0);
        const pct = target > 0 ? Math.min((saved / target) * 100, 100) : 0;
        const remaining = Math.max(target - saved, 0);

        const card = createEl('article', 'card');

        const header = createEl('div', 'card-header');
        header.appendChild(createEl('div', 'goal-title', goal.name));

        const actions = createEl('div', 'action-btns');

        const edit = createEl('button', 'edit-btn', '✎');
        edit.type = 'button';
        edit.addEventListener('click', () => openModal(goal.id));

        const del = createEl('button', 'del-btn', '×');
        del.type = 'button';
        del.addEventListener('click', () => deleteGoal(goal.id));

        actions.appendChild(edit);
        actions.appendChild(del);
        header.appendChild(actions);

        card.appendChild(header);
        card.appendChild(createEl('div', 'goal-amount', money(target)));
        card.appendChild(createEl('div', 'saved-line', `Saved ${money(saved)} • Remaining ${money(remaining)}`));

        const progressTrack = createEl('div', 'progress-track');
        const progressFill = createEl('div', 'progress-fill');
        progressFill.style.width = `${pct}%`;
        progressTrack.appendChild(progressFill);
        card.appendChild(progressTrack);

        const projection = createEl('div', 'projection');
        projection.appendChild(createEl('div', 'proj-label', 'Projected completion'));

        const date = createEl('div', 'proj-date', projectionText(goal));
        date.id = `date_${goal.id}`;
        projection.appendChild(date);
        card.appendChild(projection);

        const sliderContainer = createEl('div', 'slider-container');
        const sliderHeader = createEl('div', 'slider-header');
        sliderHeader.appendChild(createEl('span', '', 'Monthly Savings Plan'));

        const label = createEl('span', '', `${money(goal.monthly)} / mo`);
        label.id = `lbl_${goal.id}`;
        label.style.color = 'var(--accent)';
        sliderHeader.appendChild(label);

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = `slide_${goal.id}`;
        slider.min = '25';
        slider.max = String(Math.max(target, 50));
        slider.step = '25';
        slider.value = String(Number(goal.monthly || 25));
        slider.addEventListener('input', () => updateSliderPreview(goal.id));
        slider.addEventListener('change', () => saveSliderState(goal.id));

        sliderContainer.appendChild(sliderHeader);
        sliderContainer.appendChild(slider);
        card.appendChild(sliderContainer);

        container.appendChild(card);
    });
}

function updateSliderPreview(id) {
    const goal = goals.find(g => g.id === id);
    if (!goal) return;

    const monthly = validAmount($(`slide_${id}`).value);
    if (!monthly) return;

    $(`lbl_${id}`).textContent = `${money(monthly)} / mo`;
    $(`date_${id}`).textContent = projectionText(goal, monthly);
}

async function saveSliderState(id) {
    const monthly = validAmount($(`slide_${id}`).value);

    if (!monthly) {
        alert('Invalid monthly amount.');
        return;
    }

    await setDoc(doc(db, `households/${activeHouseholdId}/goals/${id}`), {
        monthly,
        ...updateMetadata()
    }, { merge: true });
}

function openModal(id = null) {
    editingGoalId = id;

    if (id) {
        const goal = goals.find(x => x.id === id);
        if (!goal) return;

        $('inputName').value = filterPlainText(goal.name, 60);
        $('inputAmt').value = Number(goal.amount || '');
        $('inputMonthly').value = Number(goal.monthly || '');
        $('modalTitle').textContent = 'Edit Target';
    } else {
        $('inputName').value = '';
        $('inputAmt').value = '';
        $('inputMonthly').value = '';
        $('modalTitle').textContent = 'New Target';
    }

    setHidden($('goalModal'), false);
}

function closeModal() {
    setHidden($('goalModal'), true);
    editingGoalId = null;
}

async function saveGoal() {
    const rawName = $('inputName').value;
    const name = getSafePlainText(rawName, 60);
    const amount = validAmount($('inputAmt').value);
    const monthlyInput = validAmount($('inputMonthly').value || '');
    const monthly = monthlyInput || Math.min(Math.ceil(amount / 10), amount);

    if (!name) {
        alert('Goal name rejected. Use only letters, numbers, spaces, and approved punctuation.');
        return;
    }

    if (!amount) {
        alert('Goal amount must be valid money format.');
        return;
    }

    try {
        if (editingGoalId) {
            await setDoc(doc(db, `households/${activeHouseholdId}/goals/${editingGoalId}`), {
                name,
                amount,
                monthly: Math.min(monthly, amount),
                ...updateMetadata()
            }, { merge: true });
        } else {
            await addDoc(collection(db, `households/${activeHouseholdId}/goals`), {
                name,
                amount,
                monthly: Math.min(monthly, amount),
                ...buildMetadata()
            });
        }

        closeModal();
    } catch (error) {
        console.error(error);
        alert('Goal rejected by security rules.');
    }
}

async function deleteGoal(id) {
    const saved = getSavedForGoal(id);

    if (saved > 0) {
        alert('This goal has savings transactions attached. Delete or reassign those transactions before deleting the goal.');
        return;
    }

    if (confirm('Delete this target?')) {
        await deleteDoc(doc(db, `households/${activeHouseholdId}/goals/${id}`));
    }
}

function applyInputFilters() {
    document.querySelectorAll('[data-validate]').forEach(input => {
        input.addEventListener('input', () => {
            const kind = input.dataset.validate;

            if (kind === 'money') {
                input.value = filterMoneyInput(input.value);
            } else if (kind === 'text') {
                input.value = filterPlainText(input.value, Number(input.maxLength) || 120);
            }
        });

        input.addEventListener('paste', () => {
            setTimeout(() => input.dispatchEvent(new Event('input')), 0);
        });
    });
}

function bindEvents() {
    $('createGoalBtn').addEventListener('click', () => openModal());
    $('closeGoalModalBtn').addEventListener('click', closeModal);
    $('saveGoalBtn').addEventListener('click', saveGoal);
    applyInputFilters();
}

bindEvents();

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    currentUser = user;

    try {
        activeHouseholdId = await resolveHousehold(user);
        if (activeHouseholdId) initGoalSync(activeHouseholdId);
    } catch (error) {
        console.error(error);
        $('goalsContainer').replaceChildren(createEl('p', 'muted', `Could not load goals: ${error.message}`));
    }
});
