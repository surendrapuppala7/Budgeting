import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    initializeAppCheck,
    ReCaptchaV3Provider
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getFirestore,
    collection,
    query,
    where,
    getDocs,
    doc,
    getDoc,
    setDoc
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

const $ = (id) => document.getElementById(id);

function createEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function safeText(value, max = 160) {
    return String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

function money(num) {
    return `$${Number(num || 0).toFixed(0)}`;
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

function metric(label, value) {
    const box = createEl('div', 'metric');
    box.appendChild(createEl('span', '', label));
    box.appendChild(createEl('strong', '', value));
    return box;
}

function insight(title, body, good = false) {
    const card = createEl('article', good ? 'insight-card good' : 'insight-card');
    card.appendChild(createEl('h3', '', title));
    card.appendChild(createEl('p', '', body));
    return card;
}

async function analyzeData(householdId) {
    const container = $('insights');
    container.replaceChildren();

    const settingsSnap = await getDoc(doc(db, `households/${householdId}/settings/data`));
    const txsSnap = await getDocs(collection(db, `households/${householdId}/transactions`));
    const goalsSnap = await getDocs(collection(db, `households/${householdId}/goals`));

    if (!settingsSnap.exists() || txsSnap.empty) {
        container.appendChild(createEl('p', 'muted', 'Not enough data yet. Log some transactions to get insights.'));
        return;
    }

    const categories = Array.isArray(settingsSnap.data().categories) ? settingsSnap.data().categories : [];
    const goals = [];

    goalsSnap.forEach(d => goals.push({ id: d.id, ...d.data() }));

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    const allTxs = [];
    const monthTxs = [];

    txsSnap.forEach(d => {
        const tx = d.data();
        allTxs.push(tx);

        if (Number(tx.timestamp || 0) >= startOfMonth) {
            monthTxs.push(tx);
        }
    });

    const totalInc = monthTxs.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amt || 0), 0);
    const totalExp = monthTxs.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amt || 0), 0);
    const totalSav = monthTxs.filter(t => t.type === 'savings').reduce((s, t) => s + Number(t.amt || 0), 0);

    const available = totalInc - totalExp - totalSav;
    const allocationRate = totalInc > 0 ? ((totalExp + totalSav) / totalInc) * 100 : 0;

    const grid = createEl('div', 'metric-grid');
    grid.appendChild(metric('Income', money(totalInc)));
    grid.appendChild(metric('Spent', money(totalExp)));
    grid.appendChild(metric('Saved', money(totalSav)));
    container.appendChild(grid);

    if (available < 0) {
        container.appendChild(insight(
            '⚠️ Negative Available Cash',
            `Your monthly available balance is ${money(available)}. Expenses and savings are higher than income for this period. Reduce flexible spending or pause extra savings until cash flow is positive.`
        ));
    } else if (allocationRate > 90) {
        container.appendChild(insight(
            '⚠️ Tight Cash Flow',
            `You have allocated ${allocationRate.toFixed(1)}% of monthly income toward expenses and savings. That leaves very little buffer for surprises.`
        ));
    } else {
        container.appendChild(insight(
            '✅ Cash Flow Stable',
            `You still have ${money(available)} available this month after spending and savings. Keep watching flexible categories so this stays positive.`,
            true
        ));
    }

    if (totalSav > 0) {
        container.appendChild(insight(
            '🌱 Savings Momentum',
            `You moved ${money(totalSav)} into savings this month. Savings reduce spendable cash, but they should not be treated like wasteful spending.`,
            true
        ));
    }

    categories.filter(c => c.type === 'expense').forEach(cat => {
        const spent = monthTxs
            .filter(t => t.type === 'expense' && t.catId === cat.id)
            .reduce((s, t) => s + Number(t.amt || 0), 0);

        const budget = Number(cat.budget || 0);
        const catName = safeText(cat.name, 80);

        if (budget > 0 && spent >= budget) {
            container.appendChild(insight(
                '🔥 Envelope Over Limit',
                `${catName} is at ${money(spent)} against a ${money(budget)} limit. This category needs attention before adding more discretionary spending.`
            ));
        } else if (budget > 0 && spent >= budget * 0.8) {
            container.appendChild(insight(
                '⚠️ Envelope Near Limit',
                `${catName} has used ${money(spent)} of its ${money(budget)} monthly limit. You are above 80%, so this is worth watching.`
            ));
        }
    });

    goals.forEach(goal => {
        const saved = allTxs
            .filter(t => t.type === 'savings' && t.goalId === goal.id)
            .reduce((s, t) => s + Number(t.amt || 0), 0);

        const target = Number(goal.amount || 0);
        const pct = target > 0 ? (saved / target) * 100 : 0;
        const goalName = safeText(goal.name, 80);

        if (target > 0 && pct >= 100) {
            container.appendChild(insight(
                '🏁 Goal Funded',
                `${goalName} is fully funded at ${money(saved)}. Consider creating the next goal or moving extra cash into an emergency fund.`,
                true
            ));
        } else if (target > 0 && pct > 0) {
            container.appendChild(insight(
                '🎯 Goal Progress',
                `${goalName} is ${pct.toFixed(1)}% funded. Current saved amount: ${money(saved)} of ${money(target)}.`,
                true
            ));
        }
    });
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    try {
        const householdId = await resolveHousehold(user);
        if (householdId) await analyzeData(householdId);
    } catch (error) {
        console.error(error);
        $('insights').replaceChildren(createEl('p', 'muted', `Unable to load advisor: ${error.message}`));
    }
});
