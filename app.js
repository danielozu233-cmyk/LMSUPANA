import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
        import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
        import { getFirestore, doc, getDoc, setDoc, collection, addDoc, updateDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
        import { getStorage, ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

        const firebaseConfig = {
            apiKey: "AIzaSyAB4hS-FR5amDK8fem-Z1t_dXn3tbRDdC8",
            authDomain: "lmsupana.firebaseapp.com",
            projectId: "lmsupana",
            storageBucket: "lmsupana.firebasestorage.app",
            messagingSenderId: "912778300770",
            appId: "1:912778300770:web:84be7166f1620ac8e6303b"
        };

        const app = initializeApp(firebaseConfig);
        const auth = getAuth(app);
        const db = getFirestore(app);
        const storage = getStorage(app);

        let currentUser = null;
        let localCourses = [];
        let localUsers = [];
        let localWaves = [];
        let localAssignments = [];
        let localProgress = [];
        let localUPANAHOOTs = [];
        let localEvaluations = [];
        let localActivityContents = [];
        let localUPANAHOOTSessions = [];
        let localDayClosures = [];
        let localSelfStudySubmissions = [];
        let agentUPANAHOOTTimerHandle = null;
        let selectedCourseId = null;
        let selectedDashboardCourseId = null;
        let selectedDashboardDayKey = null;
        let courseContentSearchTerm = "";
        let presentationSearchTerm = "";
        let presentationReturnState = null;
        let courseOpenState = {};
        let courseSearchRenderTimer = null;
        let presentationSearchRenderTimer = null;
        let dayClosureState = null;
        let selfStudyState = { courseId: null, wIdx: 0, dIdx: 0, aIdx: 0 };

        let presState = {
            waveId: null, waveName: "",
            courseId: null, courseTitle: "",
            wIdx: 0, weekTitle: "",
            dIdx: 0, dayTitle: "",
            activities: [], currentAIdx: 0
        };

        const safeText = (value = "") => String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

        const toHtml = (value = "") => safeText(value).replace(/\n/g, '<br>');

        const normalizeSearch = (value = "") => String(value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim();

        function activitySearchText(course = {}, week = {}, day = {}, act = {}) {
            return normalizeSearch([
                course.title, course.description,
                week.title, day.title,
                act.title, act.type, act.description, act.objectives, act.notes
            ].join(" "));
        }

        try {
            courseOpenState = JSON.parse(localStorage.getItem('courseOpenState') || '{}') || {};
        } catch {
            courseOpenState = {};
        }

        function rememberCourseOpenState(courseId, wIdx, dIdx = null, open = true) {
            if(!courseId) return;
            const state = courseOpenState[courseId] || { weeks: {}, days: {} };
            state.weeks[String(wIdx)] = Boolean(open);
            if(dIdx !== null) state.days[`${wIdx}:${dIdx}`] = Boolean(open);
            courseOpenState[courseId] = state;
            localStorage.setItem('courseOpenState', JSON.stringify(courseOpenState));
        }

        function isCourseWeekOpen(courseId, wIdx, fallback = false) {
            return Boolean(courseOpenState[courseId]?.weeks?.[String(wIdx)] ?? fallback);
        }

        function isCourseDayOpen(courseId, wIdx, dIdx, fallback = false) {
            return Boolean(courseOpenState[courseId]?.days?.[`${wIdx}:${dIdx}`] ?? fallback);
        }

        window.rememberCourseOpenState = rememberCourseOpenState;

        const activityContentFields = ['description', 'objectives', 'youtube', 'externalUrl', 'embedCode', 'notes'];

        function getActivityContentId(courseId, act = {}) {
            return act.contentId || `act_${courseId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        }

        function activityContentPayload(act = {}) {
            return activityContentFields.reduce((payload, field) => {
                payload[field] = act[field] || '';
                return payload;
            }, {});
        }

        function hasActivityContentPayload(act = {}) {
            return activityContentFields.some(field => String(act[field] || '').trim());
        }

        function sanitizeInlineStyle(style = "") {
            const allowed = new Set(['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'text-align']);
            return String(style || '').split(';').map(rule => {
                const [prop, ...valueParts] = rule.split(':');
                const name = String(prop || '').trim().toLowerCase();
                const value = valueParts.join(':').trim();
                if(!allowed.has(name) || !value || /url\s*\(|expression\s*\(/i.test(value)) return '';
                return `${name}: ${value}`;
            }).filter(Boolean).join('; ');
        }

        function hydrateCourseContent(course = {}) {
            const weeks = (course.weeks || []).map(week => ({
                ...week,
                days: (week.days || []).map(day => ({
                    ...day,
                    activities: (day.activities || []).map(act => {
                        const stored = act.contentId ? localActivityContents.find(item => item.id === act.contentId) : null;
                        return stored ? { ...act, ...activityContentPayload(stored) } : act;
                    })
                }))
            }));
            return { ...course, weeks };
        }

        async function prepareCourseWeeksForSave(courseId, weeks = []) {
            const contentWrites = [];
            const cleanWeeks = (weeks || []).map(week => ({
                ...week,
                days: (week.days || []).map(day => ({
                    ...day,
                    activities: (day.activities || []).map(act => {
                        const next = { ...act };
                        if(hasActivityContentPayload(next)) {
                            next.contentId = getActivityContentId(courseId, next);
                            contentWrites.push(setDoc(doc(db, "activityContents", next.contentId), {
                                ...activityContentPayload(next),
                                courseId,
                                updatedAt: new Date().toISOString()
                            }, { merge: true }));
                        }
                        activityContentFields.forEach(field => delete next[field]);
                        return next;
                    })
                }))
            }));
            await Promise.all(contentWrites);
            return cleanWeeks;
        }

        async function saveCourseWeeks(course) {
            const cleanWeeks = await prepareCourseWeeksForSave(course.id, course.weeks || []);
            await updateDoc(doc(db, "courses", course.id), { weeks: cleanWeeks });
            course.weeks = cleanWeeks;
        }

        function plainTextToRichHtml(value = "") {
            const lines = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
            const html = [];
            let listType = null;

            const closeList = () => {
                if(listType) {
                    html.push(`</${listType}>`);
                    listType = null;
                }
            };

            lines.forEach(line => {
                const trimmed = line.trim();
                if(!trimmed) {
                    closeList();
                    html.push('<div><br></div>');
                    return;
                }

                const bulletMatch = trimmed.match(/^(?:\u2022|\u00b7|\*|-)\s+(.+)$/);
                const numberMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
                if(bulletMatch || numberMatch) {
                    const nextListType = bulletMatch ? 'ul' : 'ol';
                    if(listType !== nextListType) {
                        closeList();
                        listType = nextListType;
                        html.push(`<${listType}>`);
                    }
                    html.push(`<li>${safeText((bulletMatch || numberMatch)[1])}</li>`);
                    return;
                }

                closeList();
                html.push(`<div>${safeText(trimmed)}</div>`);
            });

            closeList();
            return html.join('');
        }

        function showSystemMessage(message, title = "Aviso", options = {}) {
            const modal = document.getElementById('modal-system-message');
            const titleEl = document.getElementById('system-message-title');
            const textEl = document.getElementById('system-message-text');
            const okBtn = document.getElementById('system-message-ok');
            const cancelBtn = document.getElementById('system-message-cancel');
            const iconEl = document.getElementById('system-message-icon');
            if(!modal || !titleEl || !textEl || !okBtn || !cancelBtn) return Promise.resolve(true);
            titleEl.innerText = title;
            textEl.innerText = String(message || "");
            iconEl.className = `fa-solid ${options.confirm ? 'fa-circle-question' : 'fa-circle-info'} text-xl`;
            okBtn.innerText = options.okText || 'Aceptar';
            cancelBtn.innerText = options.cancelText || 'Cancelar';
            cancelBtn.classList.toggle('hidden', !options.confirm);
            modal.classList.remove('hidden');
            return new Promise(resolve => {
                const close = (result) => {
                    modal.classList.add('hidden');
                    okBtn.onclick = null;
                    cancelBtn.onclick = null;
                    resolve(result);
                };
                okBtn.onclick = () => close(true);
                cancelBtn.onclick = () => close(false);
            });
        }

        window.showSystemMessage = showSystemMessage;
        window.alert = (message) => { showSystemMessage(message); };
        const askConfirm = (message, title = "Confirmar") => showSystemMessage(message, title, { confirm: true, okText: "Sí, continuar", cancelText: "Cancelar" });

        function renderRichHtml(value = "") {
            const raw = String(value || "");
            if(!raw.includes("<")) return toHtml(raw);
            const template = document.createElement('template');
            template.innerHTML = raw;
            template.content.querySelectorAll('script,style,iframe,object,embed').forEach(el => el.remove());
            template.content.querySelectorAll('*').forEach(el => {
                [...el.attributes].forEach(attr => {
                    const name = attr.name.toLowerCase();
                    const val = attr.value || '';
                    if(name.startsWith('on') || name === 'class' || name === 'id' || name.startsWith('data-') || (['href','src'].includes(name) && val.trim().toLowerCase().startsWith('javascript:'))) {
                        el.removeAttribute(attr.name);
                    } else if(name === 'style') {
                        const cleanStyle = sanitizeInlineStyle(val);
                        if(cleanStyle) el.setAttribute('style', cleanStyle);
                        else el.removeAttribute(attr.name);
                    } else if(!['href', 'src', 'alt', 'title', 'style', 'target', 'rel'].includes(name)) {
                        el.removeAttribute(attr.name);
                    }
                });
            });
            return template.innerHTML;
        }

        function renderPresentationRichHtml(value = "") {
            const clean = renderRichHtml(value);
            const template = document.createElement('template');
            template.innerHTML = clean;
            const blocks = [];
            let current = null;

            const startBlock = (title = "") => {
                if(current) blocks.push(current);
                current = { title, nodes: [] };
            };

            [...template.content.childNodes].forEach(node => {
                if(node.nodeType === Node.TEXT_NODE) {
                    const text = node.textContent.trim();
                    if(!text) return;
                    if(!current) startBlock();
                    current.nodes.push(`<p>${safeText(text)}</p>`);
                    return;
                }

                if(node.nodeType !== Node.ELEMENT_NODE) return;
                const tag = node.tagName.toLowerCase();
                const text = node.textContent.trim();
                if(!text && !['br', 'img'].includes(tag)) return;

                const isHeading = /^h[1-4]$/.test(tag);
                if(isHeading) {
                    startBlock(node.innerHTML);
                    return;
                }

                if(!current) startBlock();
                current.nodes.push(node.outerHTML);
            });

            if(current) blocks.push(current);
            const usableBlocks = blocks.filter(block => block.title || block.nodes.join('').trim());
            if(usableBlocks.length <= 1) return `<div class="projection-content-card">${clean}</div>`;

            return usableBlocks.map(block => `
                <section class="projection-content-card">
                    ${block.title ? `<h3>${block.title}</h3>` : ''}
                    <div class="projection-content-body">${block.nodes.join('')}</div>
                </section>
            `).join('');
        }

        function extractEmbedSrc(embedCode = "") {
            const raw = String(embedCode || "").trim();
            if(!raw) return "";
            const template = document.createElement('template');
            template.innerHTML = raw;
            const iframe = template.content.querySelector('iframe');
            const src = iframe?.getAttribute('src') || (/^https:\/\//i.test(raw) ? raw : "");
            if(!src) return "";
            try {
                const parsed = new URL(src, window.location.href);
                if(parsed.protocol !== 'https:') return "";
                return parsed.href;
            } catch {
                return "";
            }
        }

        function renderEmbedFrame(embedCode = "", title = "Video incrustado", extraClass = "") {
            const src = extractEmbedSrc(embedCode);
            if(!src) return "";
            return `<iframe src="${safeText(src)}" class="embed-preview-frame ${extraClass}" scrolling="no" frameborder="0" allowfullscreen title="${safeText(title)}"></iframe>`;
        }

        function progressKey(userId, courseId, wIdx, dIdx, aIdx) {
            return `${userId}_${courseId}_${wIdx}_${dIdx}_${aIdx}`;
        }

        function hasActivityProgress(userId, courseId, wIdx, dIdx, aIdx) {
            const exactId = progressKey(userId, courseId, wIdx, dIdx, aIdx);
            return localProgress.some(p =>
                p.id === exactId ||
                (p.userId === userId && p.courseId === courseId && Number(p.weekId) === Number(wIdx) && Number(p.dayId) === Number(dIdx) && Number(p.activityId) === Number(aIdx))
            );
        }

        function findDayClosure(courseId, wIdx, dIdx, waveId = null, weekTitle = "", dayTitle = "") {
            const norm = value => String(value || '').trim().toLowerCase();
            return localDayClosures.find(c => {
                const sameCourse = c.courseId === courseId;
                const sameWave = !waveId || !c.waveId || c.waveId === waveId;
                const sameIndex = Number(c.wIdx ?? c.weekId) === Number(wIdx) && Number(c.dIdx ?? c.dayId) === Number(dIdx);
                const sameName = (!weekTitle || norm(c.weekTitle) === norm(weekTitle)) && (!dayTitle || norm(c.dayTitle) === norm(dayTitle));
                return sameCourse && sameWave && (sameIndex || sameName);
            });
        }

        function getPdfViewerUrl(url) {
            if(!url) return "";
            const separator = url.includes('#') ? '&' : '#';
            return `${url}${separator}toolbar=1&navpanes=0&scrollbar=1&page=1&view=FitH`;
        }

        function isDirectVideoUrl(url = "") {
            return /\.(mp4|webm|ogg|mov)(\?|#|$)/i.test(String(url));
        }

        function normalizeRole(value = "") {
            const role = String(value || "").trim().toLowerCase();
            if(['admin', 'administrator', 'administrador'].includes(role)) return 'admin';
            if(['trainer', 'entrenador', 'instructor'].includes(role)) return 'trainer';
            return 'agent';
        }

        function userRole(user = {}) {
            return normalizeRole(user.role ?? user.rol ?? user.profile ?? user.perfil ?? user.userRole ?? user.tipoUsuario);
        }

        function roleLabel(role = "") {
            const normalizedRole = normalizeRole(role);
            return normalizedRole === 'admin' ? 'Administrador' : normalizedRole === 'trainer' ? 'Entrenador' : 'Agente';
        }

        function roleSubtitle(role = "") {
            return role === 'admin' ? 'Administrador de plataforma' : role === 'trainer' ? 'Entrenador de capacitación' : 'Agente de Servicio al Cliente';
        }

        function renderUserAvatar(targetId, user) {
            const target = document.getElementById(targetId);
            if(!target || !user) return;
            if(user.photoURL) target.innerHTML = `<img src="${safeText(user.photoURL)}" class="w-full h-full object-cover" alt="${safeText(user.name || 'Usuario')}">`;
            else target.innerText = (user.name || user.email || 'U').charAt(0).toUpperCase();
        }

        function renderProfileView() {
            if(!currentUser) return;
            renderUserAvatar('profile-photo-preview', currentUser);
            document.getElementById('profile-name').innerText = currentUser.name || 'Usuario';
            document.getElementById('profile-role-title').innerText = roleSubtitle(currentUser.role);
            document.getElementById('profile-email').innerText = currentUser.email || '-';
            document.getElementById('profile-role-detail').innerText = roleLabel(currentUser.role);
            document.getElementById('profile-status').innerText = currentUser.status || 'activo';
            document.getElementById('profile-join-date').innerText = currentUser.joinDate ? new Date(currentUser.joinDate).toLocaleDateString() : '-';
        }

        const views = {
            login: document.getElementById('login-view'),
            app: document.getElementById('app-view'),
            navBtns: document.querySelectorAll('.nav-btn'),
            sections: document.querySelectorAll('.view-section')
        };

        const htmlEl = document.documentElement;
        const themeToggleBtn = document.getElementById('btn-theme-toggle');
        
        if (localStorage.theme === 'dark') {
            htmlEl.classList.add('dark');
            themeToggleBtn.innerHTML = '<i class="fa-solid fa-moon"></i>';
        } else {
            htmlEl.classList.remove('dark');
            themeToggleBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
        }

        themeToggleBtn.addEventListener('click', () => {
            if (htmlEl.classList.contains('dark')) {
                htmlEl.classList.remove('dark');
                localStorage.theme = 'light';
                themeToggleBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
            } else {
                htmlEl.classList.add('dark');
                localStorage.theme = 'dark';
                themeToggleBtn.innerHTML = '<i class="fa-solid fa-moon"></i>';
            }
        });

        function activateView(target) {
            views.navBtns.forEach(b => { b.classList.remove('bg-accent/10', 'text-accent'); b.classList.add('text-gray-600', 'dark:text-gray-400'); });
            const btn = [...views.navBtns].find(b => b.getAttribute('data-target') === target);
            if(btn) {
                btn.classList.add('bg-accent/10', 'text-accent');
                btn.classList.remove('text-gray-600', 'dark:text-gray-400');
            }
            views.sections.forEach(sec => { sec.classList.remove('block'); sec.classList.add('hidden'); });
            document.getElementById(target)?.classList.remove('hidden');
            document.getElementById(target)?.classList.add('block');
        }

        views.navBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                activateView(btn.getAttribute('data-target'));
            });
        });

        document.getElementById('top-user-toggle')?.addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('top-user-menu')?.classList.toggle('open');
        });
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('top-user-menu');
            if(menu && !menu.contains(e.target)) menu.classList.remove('open');
        });
        document.getElementById('btn-open-profile')?.addEventListener('click', () => {
            document.getElementById('top-user-menu')?.classList.remove('open');
            activateView('profile-view');
        });

        function setTopUserMenuVisible(visible = true) {
            const menu = document.getElementById('top-user-menu');
            if(!menu) return;
            menu.classList.toggle('immersive-hidden', !visible);
            if(!visible) menu.classList.remove('open');
        }

        function anchorTopUserMenu() {
            const menu = document.getElementById('top-user-menu');
            if(!menu) return;
            if(menu.parentElement !== document.body) document.body.appendChild(menu);
            Object.assign(menu.style, {
                position: 'fixed',
                top: '16px',
                right: '16px',
                bottom: 'auto',
                left: 'auto',
                transform: 'none',
                margin: '0',
                zIndex: '1000'
            });
        }

        anchorTopUserMenu();
        window.addEventListener('resize', anchorTopUserMenu);

        document.getElementById('btn-login').addEventListener('click', async () => {
            const email = document.getElementById('auth-email').value;
            const pass = document.getElementById('auth-password').value;
            try { await signInWithEmailAndPassword(auth, email, pass); } catch (e) { alert("Fallo de acceso corporativo: " + e.message); }
        });

        document.getElementById('btn-register').addEventListener('click', () => {
            document.getElementById('modal-register-agent').classList.remove('hidden');
        });

        document.getElementById('btn-register-agent-submit').addEventListener('click', async () => {
            const name = document.getElementById('reg-name')?.value.trim();
            const email = document.getElementById('reg-email')?.value.trim();
            const pass = document.getElementById('reg-password')?.value;
            if(!name) return alert("Ingrese su nombre completo.");
            if(!email || !pass) return alert("Ingrese correo y contraseña.");
            try {
                const res = await createUserWithEmailAndPassword(auth, email, pass);
                await setDoc(doc(db, "users", res.user.uid), {
                    name, email, role: "agent", status: "activo", joinDate: new Date().toISOString(), photoURL: "", photoSetupPending: true
                });
                document.getElementById('modal-register-agent').classList.add('hidden');
                alert("Cuenta creada. Ya puedes ingresar.");
            } catch (e) { alert("Error de registro: " + e.message); }
        });

        document.getElementById('btn-logout').addEventListener('click', () => signOut(auth));

        async function uploadCurrentUserPhoto(fileObj) {
            if(!currentUser || !fileObj) return;
            const storageRef = ref(storage, `profile_photos/${currentUser.id}_${Date.now()}_${fileObj.name}`);
            const snap = await uploadBytesResumable(storageRef, fileObj);
            const photoURL = await getDownloadURL(snap.ref);
            await updateDoc(doc(db, "users", currentUser.id), { photoURL, photoSetupPending: false });
            currentUser = { ...currentUser, photoURL, photoSetupPending: false };
            renderUserAvatar('user-avatar', currentUser);
            renderProfileView();
        }

        function previewImageFile(inputId, previewId, buttonId = null) {
            const fileObj = document.getElementById(inputId)?.files?.[0];
            const preview = document.getElementById(previewId);
            if(!fileObj || !preview) return;
            const url = URL.createObjectURL(fileObj);
            preview.innerHTML = `<img src="${url}" class="w-full h-full object-cover" alt="Vista previa">`;
            if(buttonId) document.getElementById(buttonId).disabled = false;
        }

        document.getElementById('setup-photo-input').addEventListener('change', () => previewImageFile('setup-photo-input', 'setup-photo-preview', 'btn-upload-profile-photo'));
        document.getElementById('profile-photo-input').addEventListener('change', async () => {
            const fileObj = document.getElementById('profile-photo-input').files[0];
            if(!fileObj) return;
            await uploadCurrentUserPhoto(fileObj);
            alert("Foto de perfil actualizada.");
        });
        document.getElementById('btn-upload-profile-photo').addEventListener('click', async () => {
            const fileObj = document.getElementById('setup-photo-input').files[0];
            if(!fileObj) return;
            await uploadCurrentUserPhoto(fileObj);
            document.getElementById('modal-photo-setup').classList.add('hidden');
        });
        document.getElementById('btn-skip-profile-photo').addEventListener('click', async () => {
            if(currentUser?.id) await updateDoc(doc(db, "users", currentUser.id), { photoSetupPending: false });
            document.getElementById('modal-photo-setup').classList.add('hidden');
        });

        onAuthStateChanged(auth, async (user) => {
            if (user) {
                const docSnap = await getDoc(doc(db, "users", user.uid));
                if(docSnap.exists()){ currentUser = { id: user.uid, ...docSnap.data() }; } 
                else { currentUser = { id: user.uid, role: 'agent', name: user.email, email: user.email }; }
                
                currentUser.role = userRole(currentUser);
                currentUser.name = currentUser.name || currentUser.email || user.email || 'Usuario';
                document.getElementById('user-name').innerText = currentUser.name;
                document.getElementById('user-role').innerText = roleLabel(currentUser.role);
                renderUserAvatar('user-avatar', currentUser);
                document.getElementById('stat-myrole').innerText = roleLabel(currentUser.role);
                renderProfileView();

                document.querySelectorAll('.admin-control').forEach(el => el.style.display = currentUser.role === 'admin' ? 'block' : 'none');
                document.querySelectorAll('.trainer-control').forEach(el => el.style.display = ['admin', 'trainer'].includes(currentUser.role) ? 'block' : 'none');
                document.querySelectorAll('.agent-control').forEach(el => el.style.display = currentUser.role === 'agent' ? 'block' : 'none');
                document.querySelectorAll('.admin-trainer-control').forEach(el => el.style.display = ['admin', 'trainer'].includes(currentUser.role) ? 'block' : 'none');

                views.login.classList.add('hidden');
                views.app.classList.remove('hidden');
                setTopUserMenuVisible(true);
                activateView(currentUser.role === 'agent' ? 'agent-view' : 'dash-view');
                if(currentUser.photoSetupPending && !currentUser.photoURL) document.getElementById('modal-photo-setup').classList.remove('hidden');
                
                initRealtimePipeline();
            } else {
                setTopUserMenuVisible(false);
                views.app.classList.add('hidden');
                views.login.classList.remove('hidden');
            }
        });

        function initRealtimePipeline() {
            onSnapshot(collection(db, "courses"), (snap) => {
                localCourses = snap.docs.map(d => hydrateCourseContent({ id: d.id, ...d.data() }));
                document.getElementById('stat-courses').innerText = localCourses.length;
                renderHierarchicalTree();
                populateSelectors();
                if(currentUser.role === 'agent') renderAgentPortal();
                if(['trainer', 'admin'].includes(currentUser.role)) { renderTrainerMatrix(); renderTrainerPresenterSelector(); }
            });

            onSnapshot(collection(db, "activityContents"), (snap) => {
                localActivityContents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                localCourses = localCourses.map(course => hydrateCourseContent(course));
                renderHierarchicalTree();
                if(currentUser?.role === 'agent') { renderAgentPortal(); renderSelfStudyContent(); }
                if(['trainer', 'admin'].includes(currentUser?.role)) { renderTrainerMatrix(); renderTrainerPresenterSelector(); }
                if(!document.getElementById('presentation-view')?.classList.contains('hidden')) renderCurrentSlide();
            });

            onSnapshot(collection(db, "users"), (snap) => {
                localUsers = snap.docs.map(d => {
                    const data = d.data();
                    return { id: d.id, ...data, role: userRole(data) };
                });
                document.getElementById('stat-users').innerText = localUsers.length;
                renderUsersTable();
                populateSelectors();
            });

            onSnapshot(collection(db, "waves"), (snap) => {
                localWaves = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                document.getElementById('stat-waves').innerText = localWaves.length;
                renderWavesList();
                populateSelectors();
                if(currentUser.role === 'agent') renderAgentPortal();
                if(['trainer', 'admin'].includes(currentUser.role)) { renderTrainerMatrix(); renderTrainerPresenterSelector(); }
            });

            onSnapshot(collection(db, "courseAssignments"), (snap) => {
                localAssignments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                renderWavesList();
                renderAssignmentsTable();
                if(currentUser.role === 'agent') renderAgentPortal();
                if(['trainer', 'admin'].includes(currentUser.role)) { renderTrainerMatrix(); renderTrainerPresenterSelector(); }
            });

            onSnapshot(collection(db, "userProgress"), (snap) => {
                localProgress = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                if(currentUser.role === 'agent') renderAgentPortal();
                if(['trainer', 'admin'].includes(currentUser.role)) renderTrainerMatrix();
            });

            onSnapshot(collection(db, "kahoots"), (snap) => {
                localUPANAHOOTs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                renderUPANAHOOTBank();
                populateUPANAHOOTSelect(document.getElementById('act-kahoot-id')?.value || "");
                if(currentUser?.role === 'agent') renderAgentUPANAHOOTArea();
                if(!document.getElementById('presentation-view').classList.contains('hidden')) renderCurrentSlide();
            });

            onSnapshot(collection(db, "evaluations"), (snap) => {
                localEvaluations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                renderEvaluationsBank();
                populateEvaluationSelect(document.getElementById('act-evaluation-id')?.value || "");
                if(currentUser?.role === 'agent') renderSelfStudyContent();
            });

            onSnapshot(collection(db, "kahootSessions"), (snap) => {
                localUPANAHOOTSessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                if(currentUser?.role === 'agent') renderAgentUPANAHOOTArea();
                if(['admin', 'trainer'].includes(currentUser?.role)) renderTrainerUPANAHOOTResults();
                if(upanahootExecState.sessionId) {
                    const liveSession = localUPANAHOOTSessions.find(s => s.id === upanahootExecState.sessionId);
                    if(liveSession) {
                        upanahootExecState = { ...upanahootExecState, ...liveSession };
                        renderUPANAHOOTExecutionStep();
                    }
                }
            });

            onSnapshot(collection(db, "dayClosures"), (snap) => {
                localDayClosures = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                if(['admin', 'trainer'].includes(currentUser?.role)) {
                    renderTrainerPresenterSelector();
                    renderTrainerMatrix();
                    renderAdminSupervision();
                }
            });

            onSnapshot(collection(db, "selfStudySubmissions"), (snap) => {
                localSelfStudySubmissions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                if(currentUser?.role === 'agent') renderSelfStudyContent();
                if(['admin', 'trainer'].includes(currentUser?.role)) renderSelfStudyReviews();
            });
        }

        document.getElementById('form-user').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('u-name').value;
            const email = document.getElementById('u-email').value;
            const role = document.getElementById('u-role').value;
            try { await addDoc(collection(db, "users"), { name, email, role, status: "activo", joinDate: new Date().toISOString() }); e.target.reset(); } catch(err) { alert(err.message); }
        });

        function renderUsersTable() {
            const tbody = document.getElementById('table-users');
            if(!tbody) return;
            tbody.innerHTML = localUsers.map(u => `
                <tr class="hover:bg-gray-100 dark:hover:bg-dark/20 transition">
                    <td class="p-4 font-medium text-gray-900 dark:text-gray-100">${u.name}</td>
                    <td class="p-4 text-gray-500 dark:text-gray-400">${u.email}</td>
                    <td class="p-4"><span class="px-2 py-1 text-xs font-semibold rounded-md ${u.role === 'admin' ? 'bg-accent/20 text-indigo-500 dark:text-indigo-400' : u.role === 'trainer' ? 'bg-warning/20 text-warning' : 'bg-success/20 text-success'} uppercase tracking-wider">${roleLabel(u.role)}</span></td>
                    <td class="p-4 text-right"><button onclick="window.deleteUserProfile('${u.id}')" class="text-danger hover:text-red-500 transition text-xs font-medium"><i class="fa-solid fa-trash"></i> Eliminar</button></td>
                </tr>
            `).join('');
        }
        window.deleteUserProfile = async (id) => { if(await askConfirm("¿Eliminar este usuario?")) await deleteDoc(doc(db, "users", id)); };

        document.getElementById('form-wave')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            try { await addDoc(collection(db, "waves"), { name: document.getElementById('w-name').value }); e.target.reset(); } catch(err) { alert(err.message); }
        });
        function renderWavesList() {
            const container = document.getElementById('list-waves');
            if(!container) return;
            if(localWaves.length === 0) {
                container.innerHTML = `<div class="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-dark/40 border border-dashed border-light-border dark:border-border rounded-xl p-4">Aún no hay waves registradas.</div>`;
                return;
            }
            container.innerHTML = localWaves.map(w => {
                const courseCount = localAssignments.filter(a => String(a.type || '').toLowerCase() === 'wave_course' && (a.targetId === w.id || a.waveId === w.id)).length;
                const agentCount = localAssignments.filter(a => String(a.type || '').toLowerCase() === 'agent_wave' && (a.assignId === w.id || a.waveId === w.id)).length;
                return `
                <div class="p-4 bg-white dark:bg-dark border border-light-border dark:border-border rounded-xl text-sm shadow-sm">
                    <div class="flex items-start justify-between gap-3">
                        <div class="flex items-start gap-3 min-w-0">
                            <div class="w-9 h-9 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0"><i class="fa-solid fa-people-group"></i></div>
                            <div class="min-w-0">
                                <div class="font-black text-gray-900 dark:text-gray-100 truncate">${safeText(w.name)}</div>
                                <div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Grupo operativo de capacitación</div>
                            </div>
                        </div>
                        <button onclick="window.deleteWaveUnit('${safeText(w.id)}')" class="text-danger text-xs font-bold hover:underline shrink-0"><i class="fa-solid fa-circle-xmark mr-1"></i>Quitar</button>
                    </div>
                    <div class="grid grid-cols-2 gap-2 mt-4">
                        <div class="rounded-lg bg-accent/5 border border-accent/10 p-3">
                            <div class="text-lg font-black text-accent leading-none">${courseCount}</div>
                            <div class="text-[10px] uppercase tracking-wider font-bold text-gray-500 mt-1">Cursos</div>
                        </div>
                        <div class="rounded-lg bg-success/5 border border-success/10 p-3">
                            <div class="text-lg font-black text-success leading-none">${agentCount}</div>
                            <div class="text-[10px] uppercase tracking-wider font-bold text-gray-500 mt-1">Agentes</div>
                        </div>
                    </div>
                </div>
            `}).join('');
        }
        window.deleteWaveUnit = async (id) => { if(await askConfirm("¿Dar de baja esta Wave?")) await deleteDoc(doc(db, "waves", id)); };

        function populateSelectors() {
            if(currentUser.role !== 'admin') return;
            const getSel = id => document.getElementById(id);
            if(getSel('direct-course-select')) getSel('direct-course-select').innerHTML = localCourses.map(c => `<option value="${safeText(c.id)}">${safeText(c.title)}</option>`).join('');
            renderDirectAgentSelection();
            if(getSel('sel-assign-wave-c')) getSel('sel-assign-wave-c').innerHTML = localWaves.map(w => `<option value="${w.id}">${w.name}</option>`).join('');
            if(getSel('sel-assign-wave-a')) getSel('sel-assign-wave-a').innerHTML = localWaves.map(w => `<option value="${w.id}">${w.name}</option>`).join('');
            if(getSel('sel-assign-course')) getSel('sel-assign-course').innerHTML = localCourses.map(c => `<option value="${c.id}">${c.title}</option>`).join('');
            if(getSel('sel-assign-agent')) getSel('sel-assign-agent').innerHTML = localUsers.filter(u => u.role === 'agent').map(u => `<option value="${u.id}">${u.name}</option>`).join('');
        }

        function getDirectCourseIdsForAgent(agentId) {
            const directIds = localAssignments
                .filter(a => a.type === 'agent_course' && a.targetId === agentId)
                .map(a => a.assignId);
            const waveIds = localAssignments
                .filter(a => a.type === 'agent_wave' && a.targetId === agentId)
                .map(a => a.assignId);
            const legacyIds = localAssignments
                .filter(a => a.type === 'wave_course' && waveIds.includes(a.targetId))
                .map(a => a.assignId);
            return [...new Set([...directIds, ...legacyIds])];
        }

        function renderDirectAssignmentControls() {
            const courseSelect = document.getElementById('direct-course-select');
            const agentList = document.getElementById('direct-agent-list');
            const assignmentsList = document.getElementById('direct-assignments-list');
            if(!courseSelect || !agentList || !assignmentsList) return;

            courseSelect.innerHTML = localCourses.length
                ? localCourses.map(c => `<option value="${safeText(c.id)}">${safeText(c.title || 'Curso sin título')}</option>`).join('')
                : '<option value="">No hay cursos registrados</option>';

            const agents = localUsers.filter(u => u.role === 'agent');
            agentList.innerHTML = agents.length ? agents.map(u => `
                <label class="flex items-center gap-3 p-3 rounded-lg border border-light-border dark:border-border bg-white dark:bg-dark cursor-pointer hover:border-accent transition">
                    <input type="checkbox" class="direct-agent-checkbox w-4 h-4 accent-accent" value="${safeText(u.id)}">
                    <span class="min-w-0"><span class="block text-sm font-bold text-gray-900 dark:text-white truncate">${safeText(u.name || 'Agente')}</span><span class="block text-xs text-gray-500 truncate">${safeText(u.email || '')}</span></span>
                </label>
            `).join('') : '<div class="p-4 text-sm text-gray-500 text-center">No hay agentes disponibles.</div>';

            const directAssignments = localAssignments.filter(a => a.type === 'agent_course');
            assignmentsList.innerHTML = directAssignments.length ? directAssignments.map(a => {
                const agent = localUsers.find(u => u.id === a.targetId);
                const course = localCourses.find(c => c.id === a.assignId);
                return `<div class="flex items-center justify-between gap-4 p-4 rounded-lg border border-light-border dark:border-border bg-white dark:bg-dark">
                    <div class="min-w-0">
                        <div class="font-black text-gray-900 dark:text-white truncate">${safeText(course?.title || 'Curso no encontrado')}</div>
                        <div class="text-xs text-gray-500 mt-1"><i class="fa-solid fa-user mr-1"></i>${safeText(agent?.name || agent?.email || 'Agente no encontrado')}</div>
                    </div>
                    <button onclick="window.removeAssignment('${safeText(a.id)}')" class="w-9 h-9 shrink-0 rounded-lg text-danger hover:bg-red-50 dark:hover:bg-red-900/20" title="Quitar asignación"><i class="fa-solid fa-trash"></i></button>
                </div>`;
            }).join('') : '<div class="p-8 text-center text-sm text-gray-500 border border-dashed border-light-border dark:border-border rounded-lg">Todavía no hay asignaciones directas.</div>';
        }

        document.getElementById('btn-toggle-all-agents-unused')?.addEventListener('click', () => {
            const boxes = [...document.querySelectorAll('.direct-agent-checkbox')];
            const shouldSelect = boxes.some(box => !box.checked);
            boxes.forEach(box => box.checked = shouldSelect);
            document.getElementById('btn-toggle-all-agents').innerText = shouldSelect ? 'Quitar selección' : 'Seleccionar todos';
        });

        document.getElementById('form-direct-assignment-unused')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const courseId = document.getElementById('direct-course-select')?.value;
            const agentIds = [...document.querySelectorAll('.direct-agent-checkbox:checked')].map(box => box.value);
            if(!courseId) return alert('Seleccione un curso.');
            if(agentIds.length === 0) return alert('Seleccione al menos un agente.');
            const existing = new Set(localAssignments.filter(a => a.type === 'agent_course' && a.assignId === courseId).map(a => a.targetId));
            const pending = agentIds.filter(agentId => !existing.has(agentId));
            await Promise.all(pending.map(agentId => addDoc(collection(db, "courseAssignments"), {
                type: 'agent_course',
                targetId: agentId,
                assignId: courseId,
                assignedAt: new Date().toISOString(),
                assignedBy: currentUser.id
            })));
            alert(pending.length ? `Curso asignado a ${pending.length} agente(s).` : 'Los agentes seleccionados ya tenían este curso.');
        });
        document.getElementById('form-assign-course')?.addEventListener('submit', async (e) => {
            e.preventDefault(); await addDoc(collection(db, "courseAssignments"), { type: "wave_course", targetId: document.getElementById('sel-assign-wave-c').value, assignId: document.getElementById('sel-assign-course').value }); alert("Asignado.");
        });
        document.getElementById('form-assign-agent')?.addEventListener('submit', async (e) => {
            e.preventDefault(); await addDoc(collection(db, "courseAssignments"), { type: "agent_wave", targetId: document.getElementById('sel-assign-agent').value, assignId: document.getElementById('sel-assign-wave-a').value }); alert("Asignado.");
        });

        function renderDirectAgentSelection() {
            const container = document.getElementById('direct-agent-list');
            if(!container) return;
            const agents = localUsers.filter(u => u.role === 'agent');
            container.innerHTML = agents.length ? agents.map(u => `
                <label class="flex items-center gap-3 p-3 rounded-lg border border-transparent hover:border-accent/30 hover:bg-accent/5 cursor-pointer">
                    <input type="checkbox" class="direct-agent-checkbox w-4 h-4 accent-accent" value="${safeText(u.id)}">
                    <span class="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center font-black">${safeText((u.name || u.email || 'A').charAt(0).toUpperCase())}</span>
                    <span class="min-w-0"><strong class="block text-sm text-gray-900 dark:text-white truncate">${safeText(u.name || 'Agente')}</strong><small class="block text-gray-500 truncate">${safeText(u.email || '')}</small></span>
                </label>`).join('') : `<div class="p-4 text-sm text-center text-gray-500">No hay agentes disponibles.</div>`;
        }

        document.getElementById('btn-toggle-all-agents')?.addEventListener('click', () => {
            const boxes = [...document.querySelectorAll('.direct-agent-checkbox')];
            const selectAll = boxes.some(box => !box.checked);
            boxes.forEach(box => { box.checked = selectAll; });
            document.getElementById('btn-toggle-all-agents').innerText = selectAll ? 'Quitar selección' : 'Seleccionar todos';
        });

        document.getElementById('form-direct-assignment')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const courseId = document.getElementById('direct-course-select')?.value;
            const agentIds = [...document.querySelectorAll('.direct-agent-checkbox:checked')].map(box => box.value);
            if(!courseId) return alert("Selecciona un curso.");
            if(!agentIds.length) return alert("Selecciona al menos un agente.");
            const existing = new Set(localAssignments.filter(a => a.type === 'agent_course' && (a.courseId || a.assignId) === courseId).map(a => a.agentId || a.targetId));
            const pending = agentIds.filter(agentId => !existing.has(agentId));
            await Promise.all(pending.map(agentId => addDoc(collection(db, "courseAssignments"), {
                type: "agent_course", agentId, courseId, targetId: agentId, assignId: courseId, assignedAt: new Date().toISOString()
            })));
            alert(pending.length ? `Curso asignado a ${pending.length} agente(s).` : "Los agentes seleccionados ya tenían este curso.");
            document.querySelectorAll('.direct-agent-checkbox').forEach(box => { box.checked = false; });
        });

        function renderAssignmentsTable() {
            const directContainer = document.getElementById('direct-assignments-list');
            if(directContainer) {
                const direct = localAssignments.filter(a => a.type === 'agent_course');
                if(!direct.length) {
                    directContainer.innerHTML = `<div class="p-6 text-center text-sm text-gray-500 bg-gray-50 dark:bg-dark/40 border border-dashed border-light-border dark:border-border rounded-lg">Todavía no hay asignaciones directas.</div>`;
                    return;
                }
                const grouped = localCourses.map(course => ({
                    course,
                    assignments: direct.filter(a => (a.courseId || a.assignId) === course.id)
                })).filter(group => group.assignments.length);
                directContainer.innerHTML = grouped.map(({course, assignments}) => `
                    <div class="border border-light-border dark:border-border rounded-lg overflow-hidden">
                        <div class="flex items-center justify-between gap-3 bg-gray-50 dark:bg-dark/40 p-4">
                            <div><strong class="text-gray-900 dark:text-white">${safeText(course.title)}</strong><div class="text-xs text-gray-500 mt-1">${assignments.length} agente(s)</div></div>
                            <i class="fa-solid fa-book-open text-accent"></i>
                        </div>
                        <div class="divide-y divide-light-border dark:divide-border">${assignments.map(a => {
                            const agent = localUsers.find(u => u.id === (a.agentId || a.targetId));
                            return `<div class="flex items-center justify-between gap-3 p-3"><span class="text-sm font-bold text-gray-700 dark:text-gray-200">${safeText(agent?.name || agent?.email || 'Agente no encontrado')}</span><button onclick="window.removeAssignment('${safeText(a.id)}')" class="text-danger text-xs font-bold"><i class="fa-solid fa-xmark mr-1"></i>Quitar</button></div>`;
                        }).join('')}</div>
                    </div>`).join('');
                return;
            }
            const tbody = document.getElementById('table-assignments');
            if(!tbody) return;
            if(localAssignments.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" class="p-5 text-center text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-dark/40 rounded-xl">Aún no hay cursos o agentes vinculados a una Wave.</td></tr>`;
                return;
            }
            tbody.innerHTML = localAssignments.map(a => {
                const isCourseRelation = a.type === 'wave_course';
                const wave = localWaves.find(w => w.id === (isCourseRelation ? a.targetId : a.assignId));
                const course = localCourses.find(c => c.id === a.assignId);
                const agent = localUsers.find(u => u.id === a.targetId);
                const entityName = isCourseRelation ? (course?.title || "Curso no encontrado") : (agent?.name || agent?.email || "Agente no encontrado");
                const label = isCourseRelation ? 'Curso asignado' : 'Agente asignado';
                const icon = isCourseRelation ? 'fa-book-open' : 'fa-user-check';
                const chipClass = isCourseRelation ? 'bg-accent/10 text-accent' : 'bg-success/10 text-success';
                return `<tr class="bg-white dark:bg-dark border border-light-border dark:border-border shadow-sm">
                    <td class="p-3 rounded-l-xl">
                        <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full ${chipClass} font-black">
                            <i class="fa-solid ${icon}"></i>${label}
                        </span>
                    </td>
                    <td class="p-3 font-black text-accent">${safeText(wave ? wave.name : 'Wave no encontrada')}</td>
                    <td class="p-3 text-gray-700 dark:text-gray-300">
                        <div class="font-bold text-gray-900 dark:text-white">${safeText(entityName)}</div>
                        <div class="text-[11px] text-gray-400">${isCourseRelation ? 'Contenido asignado a la wave' : 'Persona asignada al grupo'}</div>
                    </td>
                    <td class="p-3 text-right rounded-r-xl"><button onclick="window.removeAssignment('${safeText(a.id)}')" class="text-danger text-xs font-bold hover:underline"><i class="fa-solid fa-trash mr-1"></i>Remover</button></td>
                </tr>`;
            }).join('');
        }
        window.removeAssignment = async (id) => { await deleteDoc(doc(db, "courseAssignments", id)); };

        document.getElementById('form-course').addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                await addDoc(collection(db, "courses"), {
                    title: document.getElementById('c-title').value,
                    description: document.getElementById('c-desc')?.value || '',
                    mode: document.getElementById('c-mode')?.value || 'guided',
                    weeks: [],
                    status: "activo"
                });
                e.target.reset();
            } catch(err) { alert(err.message); }
        });

        function renderHierarchicalTree() {
            const container = document.getElementById('tree-courses');
            if(!container) return;
            if(localCourses.length === 0) {
                container.innerHTML = `<div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl p-6 text-sm text-gray-500">No hay cursos registrados.</div>`;
                return;
            }
            if(!selectedCourseId || !localCourses.some(c => c.id === selectedCourseId)) selectedCourseId = localCourses[0]?.id || null;
            const selectedCourse = localCourses.find(c => c.id === selectedCourseId);
            const cardsHtml = `
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
                    ${localCourses.map(course => {
                        const isActive = course.id === selectedCourseId;
                        const isSelf = course.mode === 'self';
                        return `
                            <button onclick="window.selectCourseForManagement('${safeText(course.id)}')" class="text-left bg-light-surface dark:bg-surface border ${isActive ? 'border-accent ring-2 ring-accent/20' : 'border-light-border dark:border-border'} rounded-xl p-5 shadow-sm hover:border-accent transition">
                                <div class="flex items-start justify-between gap-3 mb-3">
                                    <div>
                                        <h3 class="font-black text-gray-900 dark:text-white text-lg">${safeText(course.title || 'Curso sin título')}</h3>
                                        <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">${safeText(course.description || 'Sin descripción registrada')}</p>
                                    </div>
                                    <span class="text-[10px] uppercase tracking-wider font-black px-2 py-1 rounded ${course.status === 'activo' ? 'bg-success/15 text-success' : 'bg-gray-100 dark:bg-dark text-gray-500'}">${safeText(course.status || 'activo')}</span>
                                </div>
                                <div class="mb-3"><span class="course-mode-pill ${isSelf ? 'bg-accent/10 text-accent' : 'bg-warning/15 text-warning'}"><i class="fa-solid ${isSelf ? 'fa-laptop-file' : 'fa-person-chalkboard'}"></i>${isSelf ? 'Autoaprendizaje' : 'Presencial'}</span></div>
                                <div class="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                                    <span><i class="fa-solid fa-calendar-week text-warning mr-1"></i>${(course.weeks || []).length} semana(s)</span>
                                    <span class="text-accent font-bold">Gestionar <i class="fa-solid fa-arrow-right ml-1"></i></span>
                                </div>
                            </button>
                        `;
                    }).join('')}
                </div>
            `;
            const courseQuery = normalizeSearch(courseContentSearchTerm);
            const filteredWeeks = selectedCourse ? (selectedCourse.weeks || []).map((week, wIdx) => {
                const weekMatches = courseQuery && normalizeSearch(week.title).includes(courseQuery);
                const days = (week.days || []).map((day, dIdx) => {
                    const dayMatches = courseQuery && normalizeSearch(day.title).includes(courseQuery);
                    const activities = (day.activities || []).map((act, aIdx) => ({ act, aIdx })).filter(({act}) => {
                        if(!courseQuery) return true;
                        return weekMatches || dayMatches || activitySearchText(selectedCourse, week, day, act).includes(courseQuery);
                    });
                    return { day, dIdx, activities, visible: !courseQuery || weekMatches || dayMatches || activities.length > 0 };
                }).filter(item => item.visible);
                return { week, wIdx, days, visible: !courseQuery || weekMatches || days.length > 0 };
            }).filter(item => item.visible) : [];
            const filteredActivityCount = filteredWeeks.reduce((total, item) => total + item.days.reduce((dayTotal, d) => dayTotal + d.activities.length, 0), 0);
            const detailHtml = selectedCourse ? `
                <div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl p-5 shadow-sm">
                    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-light-border dark:border-border pb-3 mb-3">
                        <div>
                            <h3 class="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2"><i class="fa-solid fa-book text-accent"></i> ${safeText(selectedCourse.title || 'Curso sin título')}</h3>
                            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">${safeText(selectedCourse.description || 'Sin descripción registrada')}</p>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="window.addWeekUnit('${selectedCourse.id}')" class="bg-gray-100 dark:bg-dark border border-light-border dark:border-border hover:border-accent px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 dark:text-gray-300 transition">+ Añadir Semana</button>
                            <button onclick="window.deleteCourseUnit('${selectedCourse.id}')" class="text-danger text-xs px-2"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>
                    <div class="mb-4">
                        <div class="relative">
                            <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs"></i>
                            <input id="course-content-search-input" type="search" value="${safeText(courseContentSearchTerm)}" oninput="window.setCourseContentSearch(this.value)" placeholder="Buscar actividad, tema, semana, día o contenido..." class="w-full bg-gray-50 dark:bg-dark/40 border border-light-border dark:border-border rounded-xl py-3 pl-9 pr-24 text-sm outline-none focus:border-accent text-gray-900 dark:text-white">
                            ${courseContentSearchTerm ? `<button onclick="window.setCourseContentSearch('')" class="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-black text-accent">Limpiar</button>` : ''}
                        </div>
                        ${courseContentSearchTerm ? `<div class="mt-2 text-xs font-bold text-gray-500">${filteredActivityCount} resultado(s) dentro del curso seleccionado.</div>` : ''}
                    </div>
                    <div class="space-y-3">
                        ${filteredWeeks.map(({week, wIdx, days}) => `
                            <details ontoggle="window.rememberCourseOpenState('${selectedCourse.id}', ${wIdx}, null, this.open)" class="bg-gray-50 dark:bg-dark/40 border border-light-border dark:border-border rounded-xl overflow-hidden" ${courseContentSearchTerm || isCourseWeekOpen(selectedCourse.id, wIdx, false) ? 'open' : ''}>
                                <summary class="cursor-pointer list-none flex justify-between items-center gap-3 p-3">
                                    <h4 class="text-sm font-bold text-gray-800 dark:text-gray-200"><i class="fa-solid fa-calendar-week text-warning mr-2"></i>${safeText(week.title)} <span class="text-xs text-gray-400 ml-2">${(week.days || []).length} dia(s)</span></h4>
                                    <div class="flex gap-2">
                                        <button onclick="event.preventDefault(); window.addDayUnit('${selectedCourse.id}', ${wIdx})" class="text-[11px] bg-white dark:bg-dark border border-light-border dark:border-border px-2 py-1 rounded text-gray-600 dark:text-gray-400">+ Dia</button>
                                        <button onclick="event.preventDefault(); window.deleteWeekUnit('${selectedCourse.id}', ${wIdx})" class="text-danger text-[11px] px-1"><i class="fa-solid fa-circle-minus"></i></button>
                                    </div>
                                </summary>
                                <div class="space-y-2 p-3 pt-0">
                                    ${days.map(({day, dIdx, activities}) => `
                                        <details ontoggle="window.rememberCourseOpenState('${selectedCourse.id}', ${wIdx}, ${dIdx}, this.open)" class="bg-white dark:bg-dark/20 border border-light-border dark:border-border/40 rounded-lg overflow-hidden" ${courseContentSearchTerm || isCourseDayOpen(selectedCourse.id, wIdx, dIdx, false) ? 'open' : ''}>
                                            <summary class="cursor-pointer list-none flex justify-between items-center p-2 text-xs">
                                                <span class="font-medium text-gray-800 dark:text-gray-300"><i class="fa-regular fa-calendar-check text-success mr-1.5"></i>${safeText(day.title)} <span class="text-gray-400 ml-2">${(day.activities || []).length} actividad(es)</span></span>
                                                <div class="flex gap-1">
                                                    <button onclick="event.preventDefault(); window.openActivityModal('${selectedCourse.id}', ${wIdx}, ${dIdx})" class="text-[10px] bg-accent/10 text-accent border border-accent/30 px-2 py-0.5 rounded hover:bg-accent/20 transition">+ Tema/Actividad</button>
                                                    <button onclick="event.preventDefault(); window.deleteDayUnit('${selectedCourse.id}', ${wIdx}, ${dIdx})" class="text-danger text-[10px] px-1"><i class="fa-solid fa-xmark"></i></button>
                                                </div>
                                            </summary>
                                            <ul class="space-y-1.5 p-2 pt-0">
                                                ${activities.map(({act, aIdx}) => `
                                                    <li draggable="true" ondragstart="window.activityDragStart(event, '${selectedCourse.id}', ${wIdx}, ${dIdx}, ${aIdx})" ondragover="event.preventDefault()" ondrop="window.activityDrop(event, '${selectedCourse.id}', ${wIdx}, ${dIdx}, ${aIdx})" class="text-xs bg-gray-50 dark:bg-dark/60 border border-light-border dark:border-border p-2 rounded-md flex justify-between items-center group cursor-move">
                                                        <span class="text-gray-600 dark:text-gray-400 truncate w-2/3"><strong class="text-gray-900 dark:text-gray-200">[${safeText((act.type || '').toUpperCase())}]</strong> ${safeText(act.title || '')}</span>
                                                        <div class="flex gap-2 items-center">
                                                            <div class="flex flex-col opacity-0 group-hover:opacity-100 transition px-2 border-r border-light-border dark:border-border">
                                                                <button onclick="window.moveActivity('${selectedCourse.id}', ${wIdx}, ${dIdx}, ${aIdx}, -1)" class="text-gray-400 hover:text-accent"><i class="fa-solid fa-caret-up"></i></button>
                                                                <button onclick="window.moveActivity('${selectedCourse.id}', ${wIdx}, ${dIdx}, ${aIdx}, 1)" class="text-gray-400 hover:text-accent"><i class="fa-solid fa-caret-down"></i></button>
                                                            </div>
                                                            <button onclick="window.openActivityModal('${selectedCourse.id}', ${wIdx}, ${dIdx}, ${aIdx})" class="text-accent text-[11px] p-1"><i class="fa-solid fa-pen"></i></button>
                                                            <button onclick="window.deleteActivityUnit('${selectedCourse.id}', ${wIdx}, ${dIdx}, ${aIdx})" class="text-danger text-[11px] p-1"><i class="fa-regular fa-trash-can"></i></button>
                                                        </div>
                                                    </li>
                                                `).join('') || `<li class="text-xs text-gray-400 p-2">Sin actividades.</li>`}
                                            </ul>
                                        </details>
                                    `).join('') || `<div class="text-xs text-gray-400 p-2">Sin dias.</div>`}
                                </div>
                            </details>
                        `).join('') || `<div class="text-sm text-gray-500">Este curso aún no tiene semanas configuradas.</div>`}
                    </div>
                </div>
            ` : '';
            container.innerHTML = cardsHtml + detailHtml;
        }

        window.selectCourseForManagement = (id) => {
            selectedCourseId = id;
            courseContentSearchTerm = "";
            clearTimeout(courseSearchRenderTimer);
            renderHierarchicalTree();
        };

        window.setCourseContentSearch = (value = "") => {
            courseContentSearchTerm = String(value || "");
            clearTimeout(courseSearchRenderTimer);
            if(!courseContentSearchTerm) {
                renderHierarchicalTree();
                return;
            }
            courseSearchRenderTimer = setTimeout(() => {
                renderHierarchicalTree();
                requestAnimationFrame(() => {
                    const input = document.getElementById('course-content-search-input');
                    if(input) {
                        input.focus();
                        const pos = input.value.length;
                        input.setSelectionRange(pos, pos);
                    }
                });
            }, 180);
        };

        window.addWeekUnit = async (cId) => {
            const title = prompt("Nombre de la Semana:"); if(!title) return;
            const c = localCourses.find(c => c.id === cId);
            if(!c.weeks) c.weeks = []; c.weeks.push({ title, days: [] });
            await saveCourseWeeks(c);
        };
        window.deleteWeekUnit = async (cId, wIdx) => {
            const c = localCourses.find(c => c.id === cId); c.weeks.splice(wIdx, 1);
            await saveCourseWeeks(c);
        };
        window.addDayUnit = async (cId, wIdx) => {
            const title = prompt("Nombre del Día:"); if(!title) return;
            const c = localCourses.find(c => c.id === cId); c.weeks[wIdx].days.push({ title, activities: [] });
            await saveCourseWeeks(c);
        };
        window.deleteDayUnit = async (cId, wIdx, dIdx) => {
            const c = localCourses.find(c => c.id === cId); c.weeks[wIdx].days.splice(dIdx, 1);
            await saveCourseWeeks(c);
        };
        window.deleteCourseUnit = async (id) => { if(await askConfirm("¿Eliminar curso completo?")) await deleteDoc(doc(db, "courses", id)); };

        window.moveActivity = async (cId, wIdx, dIdx, aIdx, dir) => {
            const c = localCourses.find(course => course.id === cId);
            const acts = c.weeks[wIdx].days[dIdx].activities;
            if(aIdx + dir < 0 || aIdx + dir >= acts.length) return;
            const temp = acts[aIdx];
            acts[aIdx] = acts[aIdx + dir];
            acts[aIdx + dir] = temp;
            await saveCourseWeeks(c);
        };

        let activityDragState = null;
        window.activityDragStart = (event, cId, wIdx, dIdx, aIdx) => {
            activityDragState = { cId, wIdx, dIdx, aIdx };
            event.dataTransfer.effectAllowed = 'move';
        };
        window.activityDrop = async (event, cId, wIdx, dIdx, targetIdx) => {
            event.preventDefault();
            if(!activityDragState || activityDragState.cId !== cId || Number(activityDragState.wIdx) !== Number(wIdx) || Number(activityDragState.dIdx) !== Number(dIdx)) return;
            const fromIdx = Number(activityDragState.aIdx);
            const toIdx = Number(targetIdx);
            if(fromIdx === toIdx) return;
            const c = localCourses.find(course => course.id === cId);
            const acts = c.weeks[wIdx].days[dIdx].activities || [];
            const [moved] = acts.splice(fromIdx, 1);
            acts.splice(toIdx, 0, moved);
            activityDragState = null;
            await saveCourseWeeks(c);
        };

        const modalActivity = document.getElementById('modal-activity');
        window.switchActivityTab = (tab) => {
            document.querySelectorAll('[data-activity-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.activityTab === tab));
            document.querySelectorAll('[data-activity-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.activityPanel === tab));
        };
        function populateUPANAHOOTSelect(selectedId = "") {
            const kSelect = document.getElementById('act-kahoot-id');
            if(!kSelect) return;
            if(localUPANAHOOTs.length === 0) {
                kSelect.innerHTML = `<option value="" class="bg-white dark:bg-dark">No hay UPANAHOOTs en el banco</option>`;
                kSelect.disabled = true;
                return;
            }
            kSelect.disabled = false;
            kSelect.innerHTML = localUPANAHOOTs.map(k => `<option value="${safeText(k.id)}" ${k.id === selectedId ? 'selected' : ''} class="bg-white dark:bg-dark">${safeText(k.title || 'UPANAHOOT sin título')}</option>`).join('');
        }

        window.openActivityModal = (cId, wIdx, dIdx, aIdx = null) => {
            document.getElementById('modal-course-id').value = cId;
            document.getElementById('modal-week-idx').value = wIdx;
            document.getElementById('modal-day-idx').value = dIdx;
            document.getElementById('modal-activity-idx').value = Number.isInteger(Number(aIdx)) ? aIdx : '';
            const c = localCourses.find(course => course.id === cId);
            const act = Number.isInteger(Number(aIdx)) ? c?.weeks?.[wIdx]?.days?.[dIdx]?.activities?.[aIdx] : null;
            rememberCourseOpenState(cId, wIdx, dIdx, true);
            const weekTitle = c?.weeks?.[wIdx]?.title || `Semana ${Number(wIdx) + 1}`;
            const dayTitle = c?.weeks?.[wIdx]?.days?.[dIdx]?.title || `Día ${Number(dIdx) + 1}`;
            const contextLabel = document.getElementById('activity-context-label');
            if(contextLabel) contextLabel.innerHTML = `<i class="fa-solid fa-location-dot mr-2"></i>${safeText(c?.title || 'Curso')} · ${safeText(weekTitle)} · ${safeText(dayTitle)}`;
            document.getElementById('act-title').value = act?.title || '';
            document.getElementById('act-type').value = act?.type || 'presentacion';
            document.getElementById('act-desc-editor').innerHTML = act?.description || '';
            document.getElementById('act-desc').value = act?.description || '';
            document.getElementById('act-objectives').value = act?.objectives || '';
            document.getElementById('act-youtube').value = act?.youtube || act?.externalUrl || '';
            document.getElementById('act-embed-code').value = act?.embedCode || '';
            document.getElementById('act-notes').value = act?.notes || '';
            document.getElementById('act-duration').value = act?.duration || '';
            document.getElementById('act-content-order').value = act?.contentOrder || 'media-first';
            document.getElementById('field-embed-code').dataset.open = act?.embedCode ? 'true' : 'false';
            if(document.getElementById('act-evaluation-id')) document.getElementById('act-evaluation-id').value = act?.evaluationId || '';
            
            populateUPANAHOOTSelect(act?.kahootId || '');
            populateEvaluationSelect(act?.evaluationId || '');
            document.getElementById('btn-save-activity').innerText = act ? 'Guardar Cambios de Actividad' : 'Añadir Tema/Actividad al Día';
            
            modalActivity.classList.remove('hidden');
            window.switchActivityTab('basic');
            window.toggleActivityFields();
        };

        window.toggleActivityFields = () => {
            const type = document.getElementById('act-type').value;
            document.getElementById('field-file').style.display = ['imagen', 'pdf', 'practica', 'presentacion', 'video'].includes(type) ? 'block' : 'none';
            document.getElementById('field-youtube').style.display = type === 'video' ? 'block' : 'none';
            document.getElementById('field-embed-code').style.display = type === 'video' && document.getElementById('field-embed-code').dataset.open === 'true' ? 'block' : 'none';
            document.getElementById('field-kahoot').style.display = type === 'kahoot' ? 'block' : 'none';
            document.getElementById('field-evaluation').style.display = type === 'evaluacion' ? 'block' : 'none';
            document.getElementById('field-desc').style.display = type !== 'kahoot' ? 'block' : 'none';
            document.getElementById('field-content-order').style.display = type !== 'kahoot' ? 'block' : 'none';
        };

        window.toggleEmbedCodeField = () => {
            const field = document.getElementById('field-embed-code');
            field.dataset.open = field.dataset.open === 'true' ? 'false' : 'true';
            window.toggleActivityFields();
        };

        document.getElementById('btn-close-modal').addEventListener('click', () => {
            modalActivity.classList.add('hidden');
            ['act-title','act-desc','act-objectives','act-youtube','act-embed-code','act-notes','act-duration','act-file','modal-activity-idx','act-evaluation-id'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
            document.getElementById('act-content-order').value = 'media-first';
            document.getElementById('act-desc-editor').innerHTML = '';
            document.getElementById('field-embed-code').dataset.open = 'false';
            document.getElementById('btn-save-activity').innerText = 'Añadir Tema/Actividad al Día';
            document.getElementById('act-file-label').innerText = 'Seleccionar archivo desde tu equipo';
        });
        document.getElementById('btn-close-modal-top').addEventListener('click', () => document.getElementById('btn-close-modal').click());
        document.getElementById('act-file').addEventListener('change', () => {
            const fileObj = document.getElementById('act-file').files[0];
            document.getElementById('act-file-label').innerText = fileObj ? fileObj.name : 'Seleccionar archivo desde tu equipo';
        });

        window.richCommand = (command, value = null) => {
            document.getElementById('act-desc-editor').focus();
            document.execCommand(command, false, value);
        };

        window.addRichLink = () => {
            const url = prompt("URL del enlace:");
            if(!url) return;
            window.richCommand('createLink', url);
        };

        document.getElementById('act-desc-editor').addEventListener('paste', (event) => {
            event.preventDefault();
            const html = event.clipboardData?.getData('text/html');
            const text = event.clipboardData?.getData('text/plain') || '';
            const clean = html ? renderRichHtml(html) : plainTextToRichHtml(text);
            document.execCommand('insertHTML', false, clean);
        });

        document.getElementById('btn-save-activity').addEventListener('click', async () => {
            const saveBtn = document.getElementById('btn-save-activity');
            const progressEl = document.getElementById('upload-progress');
            const cId = document.getElementById('modal-course-id').value;
            const wIdx = parseInt(document.getElementById('modal-week-idx').value);
            const dIdx = parseInt(document.getElementById('modal-day-idx').value);
            const editIdxRaw = document.getElementById('modal-activity-idx').value;
            const editIdx = editIdxRaw === '' ? null : parseInt(editIdxRaw);
            
            const title = document.getElementById('act-title').value;
            const type = document.getElementById('act-type').value;
            const description = document.getElementById('act-desc-editor').innerHTML.trim();
            document.getElementById('act-desc').value = description;
            const objectives = document.getElementById('act-objectives').value;
            const youtube = document.getElementById('act-youtube').value;
            const embedCode = document.getElementById('act-embed-code').value;
            const notes = document.getElementById('act-notes').value;
            const duration = document.getElementById('act-duration').value || 0;
            const fileObj = document.getElementById('act-file').files[0];
            const kahootId = document.getElementById('act-kahoot-id').value;
            const evaluationId = document.getElementById('act-evaluation-id')?.value || '';
            const contentOrder = document.getElementById('act-content-order').value || 'media-first';

            if(!title) return alert("Título obligatorio.");
            if(type === 'kahoot' && !kahootId) return alert("Seleccione un UPANAHOOT del banco antes de guardar la actividad.");
            if(type === 'evaluacion' && !evaluationId) return alert("Seleccione una evaluación del banco antes de guardar la actividad.");
            const hasUploadableFile = Boolean(fileObj && ['imagen', 'pdf', 'presentacion', 'practica', 'video'].includes(type));
            progressEl.innerHTML = hasUploadableFile
                ? '<i class="fa-solid fa-spinner fa-spin"></i> Subiendo archivo...'
                : '<i class="fa-solid fa-spinner fa-spin"></i> Guardando actividad...';
            progressEl.classList.remove('hidden');
            saveBtn.disabled = true;
            saveBtn.classList.add('opacity-60', 'cursor-wait');

            let fileUrl = "";
            if (hasUploadableFile) {
                const storageRef = ref(storage, `lms_media/${Date.now()}_${fileObj.name}`);
                try {
                    const snap = await uploadBytesResumable(storageRef, fileObj);
                    fileUrl = await getDownloadURL(snap.ref);
                } catch(e) {
                    alert("No se pudo subir el archivo: " + e.message);
                    progressEl.classList.add('hidden');
                    saveBtn.disabled = false;
                    saveBtn.classList.remove('opacity-60', 'cursor-wait');
                    return;
                }
            }

            const c = localCourses.find(course => course.id === cId);
            if(!c.weeks[wIdx].days[dIdx].activities) c.weeks[wIdx].days[dIdx].activities = [];
            const previous = editIdx !== null ? c.weeks[wIdx].days[dIdx].activities[editIdx] : null;
            const nextActivity = { 
                ...(previous || {}),
                title, type, url: fileUrl || previous?.url || '', description, objectives, youtube, externalUrl: youtube, embedCode, notes, duration, kahootId, evaluationId, contentOrder
            };
            if(editIdx !== null) c.weeks[wIdx].days[dIdx].activities[editIdx] = nextActivity;
            else c.weeks[wIdx].days[dIdx].activities.push(nextActivity);

            try {
                await saveCourseWeeks(c);
                document.getElementById('btn-close-modal').click();
            } catch(e) {
                alert("No se pudo guardar la actividad: " + (e?.message || e));
            } finally {
                progressEl.classList.add('hidden');
                saveBtn.disabled = false;
                saveBtn.classList.remove('opacity-60', 'cursor-wait');
            }
        });

        window.deleteActivityUnit = async (cId, wIdx, dIdx, aIdx) => {
            const c = localCourses.find(course => course.id === cId);
            c.weeks[wIdx].days[dIdx].activities.splice(aIdx, 1);
            await saveCourseWeeks(c);
        };

        let currentUPANAHOOTQuestions = [];
        window.currentUPANAHOOTQuestions = currentUPANAHOOTQuestions;

        function renderUPANAHOOTBank() {
            const grid = document.getElementById('upanahoots-grid');
            if(!grid) return;
            grid.innerHTML = localUPANAHOOTs.map(k => `
                <div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border p-5 rounded-xl shadow-lg relative overflow-hidden group">
                    <div class="absolute top-0 right-0 bg-warning text-dark text-[10px] font-bold px-2 py-1 rounded-bl-lg z-10">${k.questions?.length || 0} Pregs</div>
                    <h3 class="font-bold text-gray-900 dark:text-white mb-2 text-lg truncate pr-8">${safeText(k.title || 'UPANAHOOT sin título')}</h3>
                    <p class="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 h-8 mb-4">${safeText(k.description || 'Sin descripción')}</p>
                    <div class="flex gap-2">
                        <button onclick="window.editUPANAHOOT('${safeText(k.id)}')" class="flex-1 bg-gray-100 dark:bg-dark border border-light-border dark:border-border text-xs font-semibold py-2 rounded text-gray-700 dark:text-gray-300 hover:border-warning transition"><i class="fa-solid fa-pen"></i> Editar</button>
                        <button onclick="window.deleteUPANAHOOT('${safeText(k.id)}')" class="w-10 bg-red-50 dark:bg-red-900/20 text-danger border border-red-200 dark:border-red-900/30 rounded flex items-center justify-center hover:bg-red-100 dark:hover:bg-red-900/50 transition"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            `).join('');
        }

        window.editUPANAHOOT = (id) => window.openUPANAHOOTEditorModal(id);

        window.openUPANAHOOTEditorModal = (id = null) => {
            document.getElementById('modal-upanahoot-editor').classList.remove('hidden');
            if(id) {
                const k = localUPANAHOOTs.find(x => x.id === id);
                document.getElementById('ke-id').value = k.id;
                document.getElementById('ke-title').value = k.title;
                document.getElementById('ke-desc').value = k.description || '';
                currentUPANAHOOTQuestions = [...(k.questions || [])];
                window.currentUPANAHOOTQuestions = currentUPANAHOOTQuestions;
            } else {
                document.getElementById('ke-id').value = '';
                document.getElementById('ke-title').value = '';
                document.getElementById('ke-desc').value = '';
                currentUPANAHOOTQuestions = [];
                window.currentUPANAHOOTQuestions = currentUPANAHOOTQuestions;
            }
            renderUPANAHOOTQuestionsList();
        };

        window.addUPANAHOOTQuestion = () => {
            currentUPANAHOOTQuestions.push({ q: "", imageUrl: "", options: ["", "", "", ""], correct: 0, time: 20, points: 1000 });
            renderUPANAHOOTQuestionsList();
        };

        window.removeUPANAHOOTQuestion = (idx) => {
            currentUPANAHOOTQuestions.splice(idx, 1);
            renderUPANAHOOTQuestionsList();
        };

        window.duplicateUPANAHOOTQuestion = (idx) => {
            const dup = JSON.parse(JSON.stringify(currentUPANAHOOTQuestions[idx]));
            currentUPANAHOOTQuestions.splice(idx + 1, 0, dup);
            renderUPANAHOOTQuestionsList();
        };

        window.uploadUPANAHOOTQuestionImage = async (idx, fileObj) => {
            if(!fileObj) return;
            try {
                const storageRef = ref(storage, `kahoot_question_images/${Date.now()}_${fileObj.name}`);
                const snap = await uploadBytesResumable(storageRef, fileObj);
                currentUPANAHOOTQuestions[idx].imageUrl = await getDownloadURL(snap.ref);
                renderUPANAHOOTQuestionsList();
            } catch(e) {
                alert("No se pudo subir la imagen: " + e.message);
            }
        };

        function renderUPANAHOOTQuestionsList() {
            document.getElementById('ke-q-count').innerText = currentUPANAHOOTQuestions.length;
            const container = document.getElementById('ke-questions-container');
            container.innerHTML = currentUPANAHOOTQuestions.map((q, idx) => {
                const options = Array.isArray(q.options) ? q.options : ["", "", "", ""];
                while(options.length < 4) options.push("");
                return `
                    <div class="bg-white dark:bg-dark border border-light-border dark:border-border rounded-xl p-5 shadow-sm relative">
                        <div class="absolute top-4 right-4 flex gap-2">
                            <button onclick="window.duplicateUPANAHOOTQuestion(${idx})" title="Duplicar" class="text-gray-400 hover:text-accent"><i class="fa-solid fa-copy"></i></button>
                            <button onclick="window.removeUPANAHOOTQuestion(${idx})" title="Eliminar" class="text-gray-400 hover:text-danger"><i class="fa-solid fa-trash"></i></button>
                        </div>
                        
                        <div class="mb-4 pr-16">
                            <label class="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mb-1">Pregunta ${idx + 1}</label>
                            <input type="text" onchange="currentUPANAHOOTQuestions[${idx}].q = this.value" value="${safeText(q.q || '')}" class="w-full bg-transparent border-b border-light-border dark:border-border focus:border-warning py-1 outline-none text-lg font-bold text-gray-900 dark:text-white" placeholder="Escribe la pregunta aqui...">
                        </div>

                        <div class="mb-4 bg-gray-50 dark:bg-surface border border-light-border dark:border-border rounded-lg p-3">
                            <label class="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mb-2">Imagen opcional de la pregunta</label>
                            ${q.imageUrl ? `<img src="${safeText(q.imageUrl)}" class="max-h-40 rounded-lg border border-light-border dark:border-border mb-3 object-contain bg-white mx-auto">` : ''}
                            <div class="flex flex-col md:flex-row gap-2">
                                <input type="url" onchange="currentUPANAHOOTQuestions[${idx}].imageUrl = this.value" value="${safeText(q.imageUrl || '')}" placeholder="URL de imagen" class="flex-1 bg-transparent border border-light-border dark:border-border rounded p-2 text-xs text-gray-900 dark:text-white outline-none focus:border-warning">
                                <input type="file" accept="image/*" onchange="window.uploadUPANAHOOTQuestionImage(${idx}, this.files[0])" class="text-xs text-gray-500">
                            </div>
                        </div>
                        
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                            ${[0,1,2,3].map(optIdx => `
                                <div class="flex items-center gap-2 bg-gray-50 dark:bg-surface border ${Number(q.correct) === optIdx ? 'border-success' : 'border-light-border dark:border-border'} rounded p-2 transition-colors">
                                    <input type="radio" name="kq_correct_${idx}" ${Number(q.correct) === optIdx ? 'checked' : ''} onchange="currentUPANAHOOTQuestions[${idx}].correct = ${optIdx}; window.renderUPANAHOOTQuestionsList()" class="w-4 h-4 text-success focus:ring-success accent-success">
                                    <input type="text" onchange="currentUPANAHOOTQuestions[${idx}].options[${optIdx}] = this.value" value="${safeText(options[optIdx] || '')}" class="w-full bg-transparent outline-none text-sm text-gray-800 dark:text-gray-200" placeholder="Respuesta ${['A','B','C','D'][optIdx]}">
                                </div>
                            `).join('')}
                        </div>

                        <div class="flex gap-4 border-t border-light-border dark:border-border pt-3">
                            <div class="flex items-center gap-2">
                                <i class="fa-regular fa-clock text-gray-400"></i>
                                <select onchange="currentUPANAHOOTQuestions[${idx}].time = parseInt(this.value)" class="bg-transparent text-xs outline-none text-gray-600 dark:text-gray-300">
                                    <option value="10" ${Number(q.time) === 10 ? 'selected' : ''}>10 seg</option>
                                    <option value="20" ${Number(q.time || 20) === 20 ? 'selected' : ''}>20 seg</option>
                                    <option value="30" ${Number(q.time) === 30 ? 'selected' : ''}>30 seg</option>
                                    <option value="60" ${Number(q.time) === 60 ? 'selected' : ''}>1 min</option>
                                </select>
                            </div>
                            <div class="flex items-center gap-2">
                                <i class="fa-solid fa-star text-warning"></i>
                                <select onchange="currentUPANAHOOTQuestions[${idx}].points = parseInt(this.value)" class="bg-transparent text-xs outline-none text-gray-600 dark:text-gray-300">
                                    <option value="1000" ${Number(q.points || 1000) === 1000 ? 'selected' : ''}>Estandar</option>
                                    <option value="2000" ${Number(q.points) === 2000 ? 'selected' : ''}>Doble</option>
                                    <option value="0" ${Number(q.points) === 0 ? 'selected' : ''}>Sin puntos</option>
                                </select>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }
        window.renderUPANAHOOTQuestionsList = renderUPANAHOOTQuestionsList;
        window.saveUPANAHOOTToBank = async () => {
            const title = document.getElementById('ke-title').value;
            const desc = document.getElementById('ke-desc').value;
            const id = document.getElementById('ke-id').value;
            if(!title) return alert("Título obligatorio.");
            
            try {
                if(id) { await updateDoc(doc(db, "kahoots", id), { title, description: desc, questions: currentUPANAHOOTQuestions }); } 
                else { await addDoc(collection(db, "kahoots"), { title, description: desc, questions: currentUPANAHOOTQuestions }); }
                document.getElementById('modal-upanahoot-editor').classList.add('hidden');
            } catch(e) { alert(e.message); }
        };

        window.deleteUPANAHOOT = async (id) => { if(await askConfirm("¿Eliminar UPANAHOOT del banco?")) await deleteDoc(doc(db, "kahoots", id)); };

        let currentEvaluationQuestions = [];
        window.currentEvaluationQuestions = currentEvaluationQuestions;
        function renderEvaluationsBank() {
            const grid = document.getElementById('evaluations-grid');
            if(!grid) return;
            grid.innerHTML = localEvaluations.map(ev => `
                <div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border p-5 rounded-xl shadow-lg">
                    <div class="text-[10px] uppercase tracking-widest font-black text-accent mb-2">${ev.questions?.length || 0} preguntas</div>
                    <h3 class="font-bold text-gray-900 dark:text-white mb-2 text-lg truncate">${safeText(ev.title || 'Evaluación sin título')}</h3>
                    <p class="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 h-8 mb-4">${safeText(ev.description || 'Sin descripción')}</p>
                    <div class="flex gap-2">
                        <button onclick="window.openEvaluationEditorModal('${safeText(ev.id)}')" class="flex-1 bg-gray-100 dark:bg-dark border border-light-border dark:border-border text-xs font-semibold py-2 rounded text-gray-700 dark:text-gray-300 hover:border-accent transition"><i class="fa-solid fa-pen"></i> Editar</button>
                        <button onclick="window.deleteEvaluation('${safeText(ev.id)}')" class="w-10 bg-red-50 dark:bg-red-900/20 text-danger border border-red-200 dark:border-red-900/30 rounded flex items-center justify-center"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            `).join('') || `<div class="text-sm text-gray-500">No hay evaluaciones registradas.</div>`;
        }

        function populateEvaluationSelect(selectedId = "") {
            const evSelect = document.getElementById('act-evaluation-id');
            if(!evSelect) return;
            if(localEvaluations.length === 0) {
                evSelect.innerHTML = `<option value="" class="bg-white dark:bg-dark">No hay evaluaciones en el banco</option>`;
                evSelect.disabled = true;
                return;
            }
            evSelect.disabled = false;
            evSelect.innerHTML = localEvaluations.map(ev => `<option value="${safeText(ev.id)}" ${ev.id === selectedId ? 'selected' : ''} class="bg-white dark:bg-dark">${safeText(ev.title || 'Evaluación sin título')}</option>`).join('');
        }

        window.openEvaluationEditorModal = (id = null) => {
            document.getElementById('modal-evaluation-editor').classList.remove('hidden');
            const ev = id ? localEvaluations.find(x => x.id === id) : null;
            document.getElementById('ev-id').value = ev?.id || '';
            document.getElementById('ev-title').value = ev?.title || '';
            document.getElementById('ev-desc').value = ev?.description || '';
            currentEvaluationQuestions = [...(ev?.questions || [])];
            window.currentEvaluationQuestions = currentEvaluationQuestions;
            renderEvaluationQuestionsList();
        };

        window.addEvaluationQuestion = () => {
            currentEvaluationQuestions.push({ q: "", questionType: "multiple", options: ["", "", "", ""], correct: 0, points: 1000 });
            window.currentEvaluationQuestions = currentEvaluationQuestions;
            renderEvaluationQuestionsList();
        };

        window.removeEvaluationQuestion = (idx) => {
            currentEvaluationQuestions.splice(idx, 1);
            window.currentEvaluationQuestions = currentEvaluationQuestions;
            renderEvaluationQuestionsList();
        };

        function renderEvaluationQuestionsList() {
            document.getElementById('ev-q-count').innerText = currentEvaluationQuestions.length;
            const container = document.getElementById('ev-questions-container');
            container.innerHTML = currentEvaluationQuestions.map((q, idx) => {
                const options = Array.isArray(q.options) ? q.options : ["", "", "", ""];
                while(options.length < 4) options.push("");
                return `<div class="bg-white dark:bg-dark border border-light-border dark:border-border rounded-xl p-5 shadow-sm">
                    <div class="flex justify-between gap-3 mb-3">
                        <input type="text" onchange="currentEvaluationQuestions[${idx}].q = this.value" value="${safeText(q.q || '')}" class="flex-1 bg-transparent border-b border-light-border dark:border-border focus:border-accent py-1 outline-none text-lg font-bold text-gray-900 dark:text-white" placeholder="Pregunta ${idx + 1}">
                        <button onclick="window.removeEvaluationQuestion(${idx})" class="text-danger"><i class="fa-solid fa-trash"></i></button>
                    </div>
                    <select onchange="currentEvaluationQuestions[${idx}].questionType = this.value; window.renderEvaluationQuestionsList()" class="mb-3 bg-transparent border border-light-border dark:border-border rounded p-2 text-xs outline-none text-gray-600 dark:text-gray-300">
                        <option value="multiple" ${q.questionType !== 'text' ? 'selected' : ''}>Selección múltiple / autocorregible</option>
                        <option value="text" ${q.questionType === 'text' ? 'selected' : ''}>Texto libre / revisión trainer</option>
                    </select>
                    ${q.questionType === 'text' ? `<div class="text-xs text-gray-500">El trainer revisará esta respuesta y podrá asignar puntos.</div>` : `
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            ${[0,1,2,3].map(optIdx => `<div class="flex items-center gap-2 bg-gray-50 dark:bg-surface border ${Number(q.correct) === optIdx ? 'border-success' : 'border-light-border dark:border-border'} rounded p-2">
                                <input type="radio" name="evq_correct_${idx}" ${Number(q.correct) === optIdx ? 'checked' : ''} onchange="currentEvaluationQuestions[${idx}].correct = ${optIdx}; window.renderEvaluationQuestionsList()" class="w-4 h-4 accent-success">
                                <input type="text" onchange="currentEvaluationQuestions[${idx}].options[${optIdx}] = this.value" value="${safeText(options[optIdx] || '')}" class="w-full bg-transparent outline-none text-sm text-gray-800 dark:text-gray-200" placeholder="Respuesta ${optIdx + 1}">
                            </div>`).join('')}
                        </div>
                    `}
                </div>`;
            }).join('');
        }
        window.renderEvaluationQuestionsList = renderEvaluationQuestionsList;

        window.saveEvaluationToBank = async () => {
            const title = document.getElementById('ev-title').value;
            const description = document.getElementById('ev-desc').value;
            const id = document.getElementById('ev-id').value;
            if(!title) return alert("Título obligatorio.");
            const questions = currentEvaluationQuestions.map(q => q.questionType === 'text'
                ? { ...q, questionType: 'text', options: [], correct: null }
                : { ...q, questionType: 'multiple' });
            const payload = { title, description, questions };
            if(id) await updateDoc(doc(db, "evaluations", id), payload);
            else await addDoc(collection(db, "evaluations"), payload);
            document.getElementById('modal-evaluation-editor').classList.add('hidden');
        };

        window.deleteEvaluation = async (id) => { if(await askConfirm("¿Eliminar evaluación del banco?")) await deleteDoc(doc(db, "evaluations", id)); };

        function getSessionParticipants(session) {
            return Object.entries(session?.participants || {}).map(([id, data]) => ({ id, ...(data || {}) }));
        }

        function getUPANAHOOTRemainingSeconds(session) {
            if(!session?.questionEndsAt || session.status !== 'question') return 0;
            return Math.max(0, Math.ceil((new Date(session.questionEndsAt).getTime() - Date.now()) / 1000));
        }

        function buildUPANAHOOTPodium(session, upanahoot) {
            const totals = {};
            getSessionParticipants(session).forEach(p => {
                totals[p.id] = { id: p.id, name: p.name || 'Agente', score: 0 };
            });
            Object.values(session?.responses || {}).forEach(questionResponses => {
                Object.entries(questionResponses || {}).forEach(([userId, response]) => {
                    if(!totals[userId]) totals[userId] = { id: userId, name: response.userName || 'Agente', score: 0 };
                    totals[userId].score += Number(response.points || 0);
                });
            });
            return Object.values(totals).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        }

        function sessionTimeValue(session = {}) {
            return new Date(session.updatedAt || session.createdAt || session.questionStartedAt || 0).getTime() || 0;
        }

        function activeUPANAHOOTSessions() {
            return [...localUPANAHOOTSessions]
                .filter(s => !['closed', 'podium'].includes(s.status))
                .sort((a, b) => sessionTimeValue(b) - sessionTimeValue(a));
        }

        function renderAgentUPANAHOOTArea() {
            const container = document.getElementById('agent-upanahoot-area');
            if(!container || currentUser?.role !== 'agent') return;

            const joinedSession = activeUPANAHOOTSessions().find(s => s.participants?.[currentUser.id]);
            if(joinedSession) {
                if(agentUPANAHOOTTimerHandle) clearTimeout(agentUPANAHOOTTimerHandle);
                const k = localUPANAHOOTs.find(x => x.id === joinedSession.kahootId);
                const qIdx = Number(joinedSession.qIdx || 0);
                const q = k?.questions?.[qIdx];
                const answer = joinedSession.responses?.[qIdx]?.[currentUser.id];
                const colors = ['#e21b3c', '#1368ce', '#d89e00', '#26890c'];
                const iconClasses = ['fa-play -rotate-90', 'fa-gem', 'fa-circle', 'fa-square'];
                const remaining = getUPANAHOOTRemainingSeconds(joinedSession);
                const statusText = joinedSession.status === 'lobby' ? 'Esperando que el trainer inicie' :
                    joinedSession.status === 'question' ? `Pregunta ${qIdx + 1}` :
                    joinedSession.status === 'results' ? 'Resultados de la pregunta' :
                    joinedSession.status === 'podium' ? 'Podio final' : 'Conectado';
                const podium = buildUPANAHOOTPodium(joinedSession, k);

                const questionHtml = q && joinedSession.status === 'question' ? `
                    <div class="w-full max-w-5xl grid grid-cols-1 md:grid-cols-2 gap-4 mt-8">
                        ${(q.options || []).map((opt, optIdx) => `
                            <button type="button" onpointerdown="window.answerUPANAHOOTQuestion('${safeText(joinedSession.id)}', ${optIdx}, this, event)" ontouchstart="window.answerUPANAHOOTQuestion('${safeText(joinedSession.id)}', ${optIdx}, this, event)" onclick="window.answerUPANAHOOTQuestion('${safeText(joinedSession.id)}', ${optIdx}, this, event)" ${answer || remaining <= 0 ? 'disabled' : ''} class="upanahoot-answer-card min-h-28 rounded-lg p-5 text-left text-white shadow-xl flex items-center gap-4 transition ${answer?.answerIndex === optIdx ? 'ring-4 ring-white scale-[1.01]' : 'hover:scale-[1.01] active:scale-[.99]'} ${answer || remaining <= 0 ? 'opacity-80 cursor-default' : 'cursor-pointer'}" style="background:${colors[optIdx] || colors[0]}">
                                <i class="fa-solid ${iconClasses[optIdx] || 'fa-circle'} text-4xl opacity-90 shrink-0"></i>
                                <span class="text-xl md:text-2xl font-black leading-tight">${safeText(opt || '')}</span>
                            </button>
                        `).join('')}
                    </div>
                    ${answer ? `<div class="mt-6 text-lg font-black bg-white text-[#46178f] rounded-lg px-6 py-3 shadow">Respuesta registrada</div>` : remaining <= 0 ? `<div class="mt-6 text-lg font-black bg-white text-[#46178f] rounded-lg px-6 py-3 shadow">Tiempo finalizado</div>` : ''}
                ` : '';

                const resultHtml = q && joinedSession.status === 'results' ? `
                    <div class="w-full max-w-3xl mt-8 bg-white text-[#46178f] rounded-xl p-6 shadow-2xl text-center">
                        <div class="text-sm uppercase tracking-widest font-black opacity-70 mb-2">Resultado</div>
                        <div class="text-2xl font-black">${answer ? (answer.isCorrect ? 'Correcta' : 'Incorrecta') : 'Sin respuesta'}</div>
                        ${answer ? `<div class="mt-2 text-gray-700 font-bold">${safeText(q.options?.[answer.answerIndex] || '')} · ${Number(answer.points || 0)} pts</div>` : ''}
                    </div>
                ` : '';

                const podiumHtml = joinedSession.status === 'podium' ? `
                    <div class="w-full max-w-4xl mt-8 grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                        ${podium.slice(0, 3).map((p, idx) => `
                            <div class="bg-white text-[#46178f] rounded-xl p-6 shadow-2xl text-center ${idx === 0 ? 'md:order-2 md:min-h-56' : idx === 1 ? 'md:order-1 md:min-h-44' : 'md:order-3 md:min-h-36'}">
                                <div class="text-4xl font-black mb-2">${idx + 1}</div>
                                <div class="text-xl font-black truncate">${safeText(p.name)}</div>
                                <div class="text-2xl font-black text-warning mt-2">${p.score} pts</div>
                            </div>
                        `).join('') || `<div class="bg-white text-[#46178f] rounded-xl p-6 shadow-2xl text-center md:col-span-3 font-black">Sin respuestas registradas</div>`}
                    </div>
                ` : '';

                container.innerHTML = `
                    <div class="fixed inset-0 z-[65] bg-[#46178f] text-white flex flex-col">
                        <div class="h-16 bg-[#32105f] flex items-center justify-between px-4 md:px-8 shadow">
                            <div class="font-black text-xl md:text-2xl">UPANA<span class="text-cyan-200">HOOT</span></div>
                            <div class="font-black text-sm md:text-lg">PIN ${safeText(joinedSession.pin)}</div>
                            <button onclick="window.leaveUPANAHOOTSession('${safeText(joinedSession.id)}')" class="bg-white/15 hover:bg-white/25 px-3 py-2 rounded text-sm font-bold">Salir</button>
                        </div>
                        <div class="flex-1 overflow-y-auto p-5 md:p-10 flex flex-col items-center justify-center text-center">
                            <div class="text-xs uppercase tracking-widest font-black opacity-75 mb-2">${safeText(statusText)}</div>
                            <h2 class="text-3xl md:text-5xl font-black leading-tight max-w-5xl">${safeText(q?.q || k?.title || joinedSession.upanahootTitle || 'UPANAHOOT')}</h2>
                            ${q?.imageUrl ? `<img src="${safeText(q.imageUrl)}" class="mt-5 max-h-64 max-w-full rounded-xl shadow-2xl object-contain bg-white/10">` : ''}
                            ${joinedSession.status === 'question' ? `<div class="mt-5 w-24 h-24 rounded-full bg-white text-[#46178f] flex items-center justify-center text-4xl font-black shadow-2xl">${remaining}</div>` : ''}
                            ${questionHtml}
                            ${resultHtml}
                            ${podiumHtml}
                        </div>
                    </div>
                `;
                if(joinedSession.status === 'question' && remaining > 0) {
                    agentUPANAHOOTTimerHandle = setTimeout(renderAgentUPANAHOOTArea, 1000);
                }
                return;
            }
            if(agentUPANAHOOTTimerHandle) clearTimeout(agentUPANAHOOTTimerHandle);

            container.innerHTML = `
                <div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl p-5 shadow">
                    <div class="flex flex-col md:flex-row md:items-end gap-4">
                        <div class="flex-1">
                            <label class="text-xs uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Unirse a UPANAHOOT</label>
                            <input id="agent-upanahoot-pin" type="text" inputmode="numeric" maxlength="6" placeholder="PIN de 6 dígitos" class="mt-2 w-full bg-transparent border border-light-border dark:border-border p-3 rounded-lg text-sm focus:border-warning outline-none text-gray-900 dark:text-white">
                        </div>
                        <button onclick="window.joinUPANAHOOTByPin()" class="bg-warning text-dark px-6 py-3 rounded-lg text-sm font-black hover:bg-yellow-400 transition"><i class="fa-solid fa-bolt mr-2"></i>Entrar</button>
                    </div>
                </div>
            `;
        }
        window.joinUPANAHOOTByPin = async () => {
            const pin = (document.getElementById('agent-upanahoot-pin')?.value || '').trim();
            if(!pin) return alert("Ingrese el PIN del UPANAHOOT.");
            const session = activeUPANAHOOTSessions().find(s => String(s.pin).trim() === pin);
            if(!session) return alert("No se encontró una sesión activa con ese PIN.");

            const updates = localUPANAHOOTSessions
                .filter(s => s.id !== session.id && !['closed', 'podium'].includes(s.status) && s.participants?.[currentUser.id])
                .map(s => {
                    const participants = { ...(s.participants || {}) };
                    delete participants[currentUser.id];
                    return updateDoc(doc(db, "kahootSessions", s.id), { participants, updatedAt: new Date().toISOString() });
                });
            updates.push(updateDoc(doc(db, "kahootSessions", session.id), {
                participants: {
                    ...(session.participants || {}),
                    [currentUser.id]: {
                        name: currentUser.name || currentUser.email || 'Agente',
                        email: currentUser.email || '',
                        joinedAt: new Date().toISOString()
                    }
                },
                updatedAt: new Date().toISOString()
            }));
            await Promise.all(updates);
        };

        window.answerUPANAHOOTQuestion = async (sessionId, answerIndex, buttonEl = null, event = null) => {
            if(event) {
                event.preventDefault();
                event.stopPropagation();
            }
            if(buttonEl?.dataset?.answering === 'true') return;
            if(buttonEl) {
                buttonEl.dataset.answering = 'true';
                buttonEl.disabled = true;
                buttonEl.classList.add('ring-4', 'ring-white', 'scale-[1.01]');
            }
            const session = localUPANAHOOTSessions.find(s => s.id === sessionId);
            if(!session || session.status !== 'question') return alert("La pregunta no está activa.");
            const k = localUPANAHOOTs.find(x => x.id === session.kahootId);
            const qIdx = Number(session.qIdx || 0);
            const q = k?.questions?.[qIdx];
            if(!q) return alert("No se encontró la pregunta activa.");
            if(getUPANAHOOTRemainingSeconds(session) <= 0) return alert("El tiempo de esta pregunta finalizó.");
            if(session.responses?.[qIdx]?.[currentUser.id]) return;
            const isCorrect = Number(q.correct) === Number(answerIndex);
            const basePoints = Number(q.points ?? 1000);

            const responses = { ...(session.responses || {}) };
            responses[qIdx] = { ...(responses[qIdx] || {}) };
            responses[qIdx][currentUser.id] = {
                answerIndex,
                isCorrect,
                points: isCorrect ? basePoints : 0,
                userName: currentUser.name || currentUser.email || 'Agente',
                answeredAt: new Date().toISOString()
            };
            await updateDoc(doc(db, "kahootSessions", sessionId), { responses, updatedAt: new Date().toISOString() }).catch(e => {
                if(buttonEl) {
                    buttonEl.dataset.answering = 'false';
                    buttonEl.disabled = false;
                    buttonEl.classList.remove('ring-4', 'ring-white', 'scale-[1.01]');
                }
                alert("No se pudo registrar la respuesta: " + (e?.message || e));
            });
        };
        window.leaveUPANAHOOTSession = async (sessionId) => {
            const session = localUPANAHOOTSessions.find(s => s.id === sessionId);
            if(!session) return;
            const participants = { ...(session.participants || {}) };
            delete participants[currentUser.id];
            await updateDoc(doc(db, "kahootSessions", sessionId), { participants, updatedAt: new Date().toISOString() });
        };

        function renderAgentPortal() {
            const container = document.getElementById('agent-courses-area');
            if(!container || currentUser.role !== 'agent') return;
            renderAgentUPANAHOOTArea();

            const bWaves = localAssignments.filter(a => a.type === 'agent_wave' && a.targetId === currentUser.id).map(a => a.assignId);
            const legacyCourseIds = localAssignments.filter(a => a.type === 'wave_course' && bWaves.includes(a.targetId)).map(a => a.assignId);
            const directCourseIds = localAssignments.filter(a => a.type === 'agent_course' && (a.agentId || a.targetId) === currentUser.id).map(a => a.courseId || a.assignId);
            const bCourseIds = [...new Set([...legacyCourseIds, ...directCourseIds])];
            const courses = localCourses.filter(c => bCourseIds.includes(c.id));

            if(courses.length === 0) {
                container.innerHTML = `<div class="p-6 text-center text-gray-500 bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl">Todavía no tienes cursos asignados.</div>`;
                return;
            }

            container.innerHTML = `
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    ${courses.map(course => {
                        let total = 0;
                        let done = 0;
                        let currentWeek = 'Sin semana';
                        let currentDay = 'Sin día';
                        (course.weeks || []).forEach((week, wIdx) => (week.days || []).forEach((day, dIdx) => (day.activities || []).forEach((act, aIdx) => {
                            total++;
                            const completed = hasActivityProgress(currentUser.id, course.id, wIdx, dIdx, aIdx);
                            if(completed) done++;
                            if(!completed && currentWeek === 'Sin semana') {
                                currentWeek = week.title || `Semana ${wIdx + 1}`;
                                currentDay = day.title || `Día ${dIdx + 1}`;
                            }
                        })));
                        if(total && done === total) {
                            const lastWeek = (course.weeks || [])[Math.max(0, (course.weeks || []).length - 1)];
                            const lastDay = (lastWeek?.days || [])[Math.max(0, (lastWeek?.days || []).length - 1)];
                            currentWeek = lastWeek?.title || 'Completado';
                            currentDay = lastDay?.title || 'Completado';
                        }
                        const pct = total ? Math.round((done / total) * 100) : 0;
                        const isSelf = course.mode === 'self';
                        return `
                            <div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl p-6 shadow">
                                <div class="flex items-start justify-between gap-3 mb-4">
                                    <div>
                                        <h3 class="text-lg font-black text-gray-900 dark:text-white">${safeText(course.title || 'Curso')}</h3>
                                        <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">${safeText(course.description || 'Curso asignado por tu trainer')}</p>
                                    </div>
                                    <span class="text-[10px] uppercase tracking-wider font-black px-2 py-1 rounded ${isSelf ? 'bg-accent/10 text-accent' : pct === 100 ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}">${isSelf ? 'Autoaprendizaje' : pct === 100 ? 'Completado' : 'Presencial'}</span>
                                </div>
                                <div class="mb-4">
                                    <div class="flex justify-between text-xs font-bold mb-1"><span class="text-gray-500">Avance validado</span><span class="text-accent">${pct}%</span></div>
                                    <div class="w-full bg-gray-200 dark:bg-dark h-2 rounded-full overflow-hidden"><div class="bg-accent h-full" style="width:${pct}%"></div></div>
                                </div>
                                <div class="grid grid-cols-2 gap-2 text-xs">
                                    <div class="bg-gray-50 dark:bg-dark/40 rounded p-3"><div class="text-gray-400 font-bold uppercase">Semana actual</div><div class="font-bold text-gray-900 dark:text-white">${safeText(currentWeek)}</div></div>
                                    <div class="bg-gray-50 dark:bg-dark/40 rounded p-3"><div class="text-gray-400 font-bold uppercase">Día actual</div><div class="font-bold text-gray-900 dark:text-white">${safeText(currentDay)}</div></div>
                                </div>
                                ${isSelf ? `<button onclick="window.openSelfStudy('${safeText(course.id)}')" class="mt-4 w-full bg-accent text-white rounded-lg py-2.5 text-sm font-black hover:bg-accent/90 transition"><i class="fa-solid fa-play mr-2"></i>Entrar al curso</button>` : `<div class="text-[11px] text-gray-400 mt-4">El avance lo registra tu trainer durante la capacitación presencial.</div>`}
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }

        function flattenCourseActivities(course) {
            const items = [];
            (course.weeks || []).forEach((week, wIdx) => (week.days || []).forEach((day, dIdx) => (day.activities || []).forEach((act, aIdx) => {
                items.push({ course, week, day, act, wIdx, dIdx, aIdx, key: `${wIdx}:${dIdx}:${aIdx}` });
            })));
            return items;
        }

        function renderLearningMedia(act) {
            if(act.type === 'video') {
                if(act.embedCode) {
                    const embed = renderEmbedFrame(act.embedCode, act.title || 'Video incrustado');
                    if(embed) return embed;
                }
                if(act.youtube) {
                    return `<iframe src="${safeText(act.youtube)}" allowfullscreen></iframe>`;
                }
                if(act.url) return `<video controls><source src="${safeText(act.url)}"></video>`;
            }
            if(act.type === 'pdf' && act.url) return `<iframe src="${safeText(getPdfViewerUrl(act.url))}"></iframe>`;
            if(act.type === 'imagen' && act.url) return `<img src="${safeText(act.url)}" alt="${safeText(act.title || 'Imagen del tema')}">`;
            if(act.url) return `<a href="${safeText(act.url)}" target="_blank" class="text-accent font-bold underline">Abrir recurso</a>`;
            return '';
        }

        window.openSelfStudy = (courseId) => {
            const course = localCourses.find(c => c.id === courseId);
            if(!course) return;
            const items = flattenCourseActivities(course);
            const firstPending = items.find(item => !hasActivityProgress(currentUser.id, course.id, item.wIdx, item.dIdx, item.aIdx)) || items[0];
            selfStudyState = { courseId, wIdx: firstPending?.wIdx || 0, dIdx: firstPending?.dIdx || 0, aIdx: firstPending?.aIdx || 0 };
            document.getElementById('self-study-view').classList.remove('hidden');
            document.getElementById('self-study-view').classList.add('flex');
            renderSelfStudyContent();
        };

        window.closeSelfStudy = () => {
            document.getElementById('self-study-view').classList.add('hidden');
            document.getElementById('self-study-view').classList.remove('flex');
        };

        window.selectSelfStudyActivity = (wIdx, dIdx, aIdx) => {
            selfStudyState = { ...selfStudyState, wIdx, dIdx, aIdx };
            renderSelfStudyContent();
        };

        window.completeSelfStudyActivity = async () => {
            if(!currentUser || !selfStudyState.courseId) return;
            const { courseId, wIdx, dIdx, aIdx } = selfStudyState;
            const docId = progressKey(currentUser.id, courseId, wIdx, dIdx, aIdx);
            await setDoc(doc(db, "userProgress", docId), {
                userId: currentUser.id,
                courseId,
                weekId: wIdx,
                dayId: dIdx,
                activityId: aIdx,
                source: 'self-study',
                status: 'completed',
                completedAt: new Date().toISOString()
            });
            renderAgentPortal();
            renderSelfStudyContent();
        };

        window.submitSelfStudyAnswer = async () => {
            const answer = document.getElementById('self-study-answer')?.value.trim();
            if(!answer) return alert("Escribe tu respuesta antes de enviar.");
            const { courseId, wIdx, dIdx, aIdx } = selfStudyState;
            const course = localCourses.find(c => c.id === courseId);
            const act = course?.weeks?.[wIdx]?.days?.[dIdx]?.activities?.[aIdx];
            await addDoc(collection(db, "selfStudySubmissions"), {
                userId: currentUser.id,
                userName: currentUser.name || currentUser.email || 'Agente',
                courseId,
                courseTitle: course?.title || '',
                weekId: wIdx,
                dayId: dIdx,
                activityId: aIdx,
                activityTitle: act?.title || '',
                answer,
                status: 'pendiente',
                points: null,
                createdAt: new Date().toISOString()
            });
            await window.completeSelfStudyActivity();
            alert("Respuesta enviada para revisión.");
        };

        window.submitSelfStudyEvaluation = async () => {
            const { courseId, wIdx, dIdx, aIdx } = selfStudyState;
            const course = localCourses.find(c => c.id === courseId);
            const act = course?.weeks?.[wIdx]?.days?.[dIdx]?.activities?.[aIdx];
            const evaluation = localEvaluations.find(k => k.id === act?.evaluationId);
            if(!evaluation) return alert("No se encontró la evaluación asociada.");
            const answers = (evaluation.questions || []).map((q, idx) => {
                if(q.questionType === 'text') {
                    const value = document.getElementById(`eval_text_${idx}`)?.value.trim() || '';
                    return { question: q.q || '', questionType: 'text', answer: value, pendingReview: true, points: 0 };
                }
                const selected = document.querySelector(`input[name="eval_q_${idx}"]:checked`)?.value;
                const answerIndex = selected === undefined ? null : Number(selected);
                const isCorrect = answerIndex !== null && Number(q.correct) === answerIndex;
                return { question: q.q || '', questionType: 'multiple', answerIndex, answer: q.options?.[answerIndex] || '', correctIndex: Number(q.correct || 0), isCorrect, points: isCorrect ? Number(q.points || 1000) : 0 };
            });
            if(answers.some(a => a.questionType === 'text' && !a.answer)) return alert("Responde todas las preguntas de texto.");
            if(answers.some(a => a.questionType !== 'text' && a.answerIndex === null)) return alert("Selecciona una respuesta en todas las preguntas.");
            const hasTextReview = answers.some(a => a.pendingReview);
            const autoPoints = answers.reduce((sum, a) => sum + Number(a.points || 0), 0);
            await addDoc(collection(db, "selfStudySubmissions"), {
                userId: currentUser.id,
                userName: currentUser.name || currentUser.email || 'Agente',
                courseId,
                courseTitle: course?.title || '',
                weekId: wIdx,
                dayId: dIdx,
                activityId: aIdx,
                activityTitle: act?.title || evaluation.title || '',
                evaluationId: evaluation.id,
                evaluationTitle: evaluation.title || '',
                answers,
                answer: answers.map((a, i) => `${i + 1}. ${a.question}\n${a.answer || 'Sin respuesta'}${a.isCorrect === false ? ' (incorrecta)' : ''}`).join('\n\n'),
                status: hasTextReview ? 'pendiente' : 'revisado',
                points: hasTextReview ? autoPoints : autoPoints,
                autoPoints,
                createdAt: new Date().toISOString()
            });
            await window.completeSelfStudyActivity();
            alert(hasTextReview ? "Evaluación enviada para revisión." : `Evaluación enviada. Punteo automático: ${autoPoints} pts.`);
        };

        function renderSelfStudyContent() {
            const view = document.getElementById('self-study-view');
            if(!view || view.classList.contains('hidden')) return;
            const course = localCourses.find(c => c.id === selfStudyState.courseId);
            if(!course) return;
            const items = flattenCourseActivities(course);
            const current = items.find(item => item.wIdx === Number(selfStudyState.wIdx) && item.dIdx === Number(selfStudyState.dIdx) && item.aIdx === Number(selfStudyState.aIdx)) || items[0];
            document.getElementById('self-study-title').innerText = course.title || 'Curso';
            document.getElementById('self-study-subtitle').innerText = 'Autoaprendizaje';
            document.getElementById('self-study-nav').innerHTML = (course.weeks || []).map((week, wIdx) => `
                <div class="mb-4">
                    <div class="text-xs uppercase tracking-widest font-black text-gray-400 mb-2">${safeText(week.title || `Semana ${wIdx + 1}`)}</div>
                    ${(week.days || []).map((day, dIdx) => `
                        <div class="mb-3 pl-3 border-l border-light-border dark:border-border">
                            <div class="text-sm font-black text-gray-900 dark:text-white mb-2">${safeText(day.title || `Día ${dIdx + 1}`)}</div>
                            ${(day.activities || []).map((act, aIdx) => {
                                const done = hasActivityProgress(currentUser.id, course.id, wIdx, dIdx, aIdx);
                                const active = current && current.wIdx === wIdx && current.dIdx === dIdx && current.aIdx === aIdx;
                                return `<button onclick="window.selectSelfStudyActivity(${wIdx},${dIdx},${aIdx})" class="w-full text-left rounded-lg border px-3 py-2 mb-1 text-xs font-bold ${active ? 'border-accent bg-accent/10 text-accent' : 'border-light-border dark:border-border text-gray-600 dark:text-gray-300'}">
                                    <i class="fa-solid ${done ? 'fa-circle-check text-success' : 'fa-circle text-warning'} mr-2"></i>${safeText(act.title || 'Actividad')}
                                </button>`;
                            }).join('')}
                        </div>
                    `).join('')}
                </div>
            `).join('');
            if(!current) {
                document.getElementById('self-study-content').innerHTML = `<div class="soft-card bg-light-surface dark:bg-surface p-6 text-gray-500">Este curso aún no tiene contenido.</div>`;
                return;
            }
            const act = current.act;
            const completed = hasActivityProgress(currentUser.id, course.id, current.wIdx, current.dIdx, current.aIdx);
            const submission = localSelfStudySubmissions
                .filter(s => s.userId === currentUser.id && s.courseId === course.id && Number(s.weekId) === current.wIdx && Number(s.dayId) === current.dIdx && Number(s.activityId) === current.aIdx)
                .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
            const mediaHtml = renderLearningMedia(act);
            const textHtml = act.description ? `<div class="learning-content text-gray-800 dark:text-gray-200 leading-relaxed">${renderRichHtml(act.description)}</div>` : '';
            const ordered = act.contentOrder === 'text-first' ? `${textHtml}${mediaHtml}` : `${mediaHtml}${textHtml}`;
            const evaluation = act.type === 'evaluacion' ? localEvaluations.find(k => k.id === act.evaluationId) : null;
            const evaluationHtml = evaluation ? `
                <div class="mt-6 border-t border-light-border dark:border-border pt-5">
                    <div class="text-xs uppercase tracking-widest font-black text-accent mb-3">Evaluación de autoaprendizaje</div>
                    <div class="space-y-4">
                        ${(evaluation.questions || []).map((q, idx) => `
                            <div class="border border-light-border dark:border-border rounded-xl p-4 bg-gray-50 dark:bg-dark/40">
                                <div class="font-black text-gray-900 dark:text-white mb-3">${idx + 1}. ${safeText(q.q || 'Pregunta')}</div>
                                ${q.imageUrl ? `<img src="${safeText(q.imageUrl)}" class="max-h-52 rounded-lg object-contain bg-white mx-auto mb-3">` : ''}
                                ${q.questionType === 'text' ? `
                                    <textarea id="eval_text_${idx}" class="w-full min-h-28 bg-white dark:bg-surface border border-light-border dark:border-border rounded-lg p-3 text-sm outline-none focus:border-accent text-gray-900 dark:text-white" placeholder="Escribe tu respuesta..."></textarea>
                                ` : `
                                    <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                                        ${(q.options || []).map((opt, optIdx) => `
                                            <label class="cursor-pointer bg-white dark:bg-surface border border-light-border dark:border-border rounded-lg p-3 text-sm text-gray-800 dark:text-gray-200">
                                                <input type="radio" name="eval_q_${idx}" value="${optIdx}" class="mr-2 accent-accent"> ${safeText(opt || `Respuesta ${optIdx + 1}`)}
                                            </label>
                                        `).join('')}
                                    </div>
                                `}
                            </div>
                        `).join('')}
                    </div>
                    <button onclick="window.submitSelfStudyEvaluation()" ${submission ? 'disabled' : ''} class="mt-5 bg-accent text-white px-5 py-2.5 rounded-lg text-sm font-black disabled:opacity-60">${submission ? 'Evaluación enviada' : 'Enviar evaluación'}</button>
                </div>
            ` : '';
            document.getElementById('self-study-content').innerHTML = `
                <article class="soft-card bg-light-surface dark:bg-surface p-5 md:p-8">
                    <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-6">
                        <div>
                            <div class="text-xs uppercase tracking-widest font-black text-accent mb-2">${safeText(current.week.title || '')} / ${safeText(current.day.title || '')}</div>
                            <h2 class="text-2xl md:text-4xl font-black text-gray-900 dark:text-white">${safeText(act.title || 'Actividad')}</h2>
                            ${act.objectives ? `<p class="text-warning font-bold mt-2">${safeText(act.objectives)}</p>` : ''}
                        </div>
                        <span class="course-mode-pill ${completed ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}">${completed ? 'Completado' : 'Pendiente'}</span>
                    </div>
                    <div class="space-y-5">${ordered || `<div class="text-gray-500">Sin contenido registrado.</div>`}</div>
                    ${evaluationHtml || (['practica', 'evaluacion'].includes(act.type) ? `
                        <div class="mt-6 border-t border-light-border dark:border-border pt-5">
                            <label class="text-xs uppercase tracking-widest font-black text-gray-500">Respuesta para revisión</label>
                            <textarea id="self-study-answer" class="mt-2 w-full min-h-32 bg-gray-50 dark:bg-dark/40 border border-light-border dark:border-border rounded-xl p-3 text-sm outline-none focus:border-accent text-gray-900 dark:text-white" ${submission ? 'disabled' : ''}>${safeText(submission?.answer || '')}</textarea>
                            <div class="mt-3 flex items-center justify-between gap-3">
                                <div class="text-xs text-gray-500">${submission ? `Estado: ${safeText(submission.status || 'pendiente')} ${submission.points != null ? `- ${Number(submission.points)} pts` : ''}` : 'Tu trainer revisará esta respuesta.'}</div>
                                ${submission ? '' : `<button onclick="window.submitSelfStudyAnswer()" class="bg-accent text-white px-5 py-2.5 rounded-lg text-sm font-black">Enviar respuesta</button>`}
                            </div>
                        </div>
                    ` : `
                        <button onclick="window.completeSelfStudyActivity()" ${completed ? 'disabled' : ''} class="mt-6 bg-success text-white px-5 py-2.5 rounded-lg text-sm font-black disabled:opacity-60"><i class="fa-solid fa-check mr-2"></i>${completed ? 'Actividad completada' : 'Marcar como completada'}</button>
                    `)}
                </article>
            `;
        }

        function renderSelfStudyReviews() {
            const panel = document.getElementById('self-study-review-panel');
            if(!panel) return;
            const pending = [...localSelfStudySubmissions].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
            panel.innerHTML = pending.map(s => `
                <div class="soft-card bg-light-surface dark:bg-surface p-4">
                    <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                        <div>
                            <div class="font-black text-gray-900 dark:text-white">${safeText(s.userName)} - ${safeText(s.activityTitle)}</div>
                            <div class="text-xs text-gray-500">${safeText(s.courseTitle)} · ${safeText(new Date(s.createdAt || Date.now()).toLocaleString())}</div>
                            <p class="mt-3 text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap">${safeText(s.answer || '')}</p>
                        </div>
                        <div class="flex items-center gap-2">
                            <input id="points_${safeText(s.id)}" type="number" min="0" placeholder="Pts" value="${s.points ?? ''}" class="w-20 bg-transparent border border-light-border dark:border-border rounded p-2 text-sm text-gray-900 dark:text-white">
                            <button onclick="window.gradeSelfStudy('${safeText(s.id)}')" class="bg-success text-white px-3 py-2 rounded text-xs font-black">Guardar</button>
                        </div>
                    </div>
                </div>
            `).join('') || `<div class="soft-card bg-light-surface dark:bg-surface p-5 text-sm text-gray-500">No hay entregas de autoaprendizaje pendientes.</div>`;
        }

        window.gradeSelfStudy = async (id) => {
            const points = Number(document.getElementById(`points_${id}`)?.value || 0);
            await updateDoc(doc(db, "selfStudySubmissions", id), {
                points,
                status: 'revisado',
                reviewedBy: currentUser?.id || '',
                reviewedAt: new Date().toISOString()
            });
        };

        function renderTrainerPresenterSelector() {
            const container = document.getElementById('trainer-presenter-selector');
            if(!container) return;
            container.innerHTML = localWaves.map(wave => {
                const cIds = localAssignments.filter(a => a.type === 'wave_course' && a.targetId === wave.id).map(a => a.assignId);
                const courses = localCourses.filter(c => cIds.includes(c.id) && c.mode !== 'self');
                if(courses.length === 0) return '';
                return `<div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border p-5 rounded-xl shadow">
                    <h4 class="font-bold text-lg text-gray-900 dark:text-white mb-4"><i class="fa-solid fa-people-group text-accent mr-2"></i>${safeText(wave.name)}</h4>
                    <div class="space-y-3">
                        ${courses.map(course => `
                            <details class="bg-gray-50 dark:bg-dark border border-light-border dark:border-border rounded-xl overflow-hidden" open>
                                <summary class="cursor-pointer list-none p-3 flex items-center justify-between gap-3">
                                    <div class="text-sm font-black text-gray-900 dark:text-white">${safeText(course.title)}</div>
                                    <div class="text-xs text-gray-400">${(course.weeks || []).length} semana(s)</div>
                                </summary>
                                <div class="p-3 pt-0 space-y-2">
                                    ${(course.weeks || []).map((w, wIdx) => `
                                        <details class="bg-white dark:bg-surface border border-light-border dark:border-border rounded-lg overflow-hidden" ${wIdx === 0 ? 'open' : ''}>
                                            <summary class="cursor-pointer list-none p-2 text-xs font-black text-gray-600 dark:text-gray-300 flex justify-between">
                                                <span>${safeText(w.title || `Semana ${wIdx + 1}`)}</span>
                                                <span class="text-gray-400">${(w.days || []).length} dia(s)</span>
                                            </summary>
                                            <div class="p-2 pt-0 space-y-1">
                                                ${(w.days || []).map((d, dIdx) => {
                                                    const done = Boolean(findDayClosure(course.id, wIdx, dIdx, wave.id, w.title || `Semana ${wIdx + 1}`, d.title || `Dia ${dIdx + 1}`));
                                                    return `<button onclick="window.startPresentation('${wave.id}', '${course.id}', ${wIdx}, ${dIdx})" class="w-full text-left bg-gray-50 dark:bg-dark/40 hover:bg-accent/10 border border-light-border dark:border-border text-xs p-2 rounded flex justify-between items-center group text-gray-800 dark:text-gray-200">
                                                        <span class="truncate"><i class="fa-solid fa-circle ${done ? 'text-success' : 'text-warning'} mr-2"></i>${safeText(d.title || `Dia ${dIdx + 1}`)}</span>
                                                        <i class="fa-solid fa-play text-accent opacity-50 group-hover:opacity-100"></i>
                                                    </button>`;
                                                }).join('') || `<div class="text-xs text-gray-400 p-2">Sin dias.</div>`}
                                            </div>
                                        </details>
                                    `).join('')}
                                </div>
                            </details>
                        `).join('')}
                    </div>
                </div>`;
            }).join('');
        }

        function getCourseProgressRows(course) {
            const rows = [];
            const addAgentRow = (agent, wave = null) => {
                if(!agent || rows.some(row => row.agent.id === agent.id)) return;
                const acts = [];
                (course.weeks || []).forEach((week, wIdx) => (week.days || []).forEach((day, dIdx) => (day.activities || []).forEach((act, aIdx) => {
                    acts.push({ week, day, wIdx, dIdx, aIdx, act });
                })));
                const done = acts.filter(x => hasActivityProgress(agent.id, course.id, x.wIdx, x.dIdx, x.aIdx));
                const pct = acts.length ? Math.round((done.length / acts.length) * 100) : 0;
                const next = acts.find(x => !hasActivityProgress(agent.id, course.id, x.wIdx, x.dIdx, x.aIdx)) || acts[acts.length - 1];
                const latestClosure = localDayClosures
                    .filter(c => c.courseId === course.id && c.attendance?.[agent.id])
                    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0];
                rows.push({ agent, wave, course, acts, done, pct, next, latestClosure });
            };
            localAssignments.filter(a => a.type === 'agent_wave').forEach(agentWave => {
                const agent = localUsers.find(u => u.id === agentWave.targetId);
                const wave = localWaves.find(w => w.id === agentWave.assignId);
                const assigned = localAssignments.some(a => a.type === 'wave_course' && a.targetId === agentWave.assignId && a.assignId === course.id);
                if(!agent || !assigned) return;
                addAgentRow(agent, wave);
            });
            localAssignments.filter(a => a.type === 'agent_course' && (a.courseId || a.assignId) === course.id).forEach(assignment => {
                addAgentRow(localUsers.find(u => u.id === (assignment.agentId || assignment.targetId)));
            });
            return rows;
        }

        function renderTrainerMatrix() {
            const container = document.getElementById('dashboard-course-progress');
            const detail = document.getElementById('dashboard-course-detail');
            if(!container || !detail) return;
            if(!selectedDashboardCourseId || !localCourses.some(c => c.id === selectedDashboardCourseId)) selectedDashboardCourseId = localCourses[0]?.id || null;
            container.innerHTML = `
                <h3 class="text-lg font-bold text-gray-900 dark:text-white mb-4"><i class="fa-solid fa-chart-line mr-2 text-accent"></i>Mapeo de Progreso por Curso</h3>
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    ${localCourses.map(course => {
                        const rows = getCourseProgressRows(course);
                        const avg = rows.length ? Math.round(rows.reduce((sum, r) => sum + r.pct, 0) / rows.length) : 0;
                        const isActive = course.id === selectedDashboardCourseId;
                        return `<button onclick="window.selectDashboardCourse('${safeText(course.id)}')" class="text-left bg-light-surface dark:bg-surface border ${isActive ? 'border-accent ring-2 ring-accent/20' : 'border-light-border dark:border-border'} rounded-xl p-5 shadow-sm hover:border-accent transition">
                            <div class="flex justify-between gap-3 mb-3">
                                <div>
                                    <h4 class="font-black text-gray-900 dark:text-white">${safeText(course.title || 'Curso')}</h4>
                                    <p class="text-xs text-gray-500 line-clamp-2">${safeText(course.description || 'Sin descripción')}</p>
                                </div>
                                <span class="text-xs font-black text-accent">${avg}%</span>
                            </div>
                            <div class="bg-gray-200 dark:bg-dark h-2 rounded-full overflow-hidden mb-3"><div class="bg-accent h-full" style="width:${avg}%"></div></div>
                            <div class="text-xs text-gray-500">${rows.length} agente(s) · ${(course.weeks || []).length} semana(s)</div>
                        </button>`;
                    }).join('') || `<div class="text-sm text-gray-500">No hay cursos registrados.</div>`}
                </div>
            `;
            renderDashboardCourseDetail();
        }

        window.selectDashboardCourse = (courseId) => {
            selectedDashboardCourseId = courseId;
            selectedDashboardDayKey = null;
            renderTrainerMatrix();
        };

        function renderDashboardCourseDetailLegacy() {
            const detail = document.getElementById('dashboard-course-detail');
            if(!detail) return;
            const course = localCourses.find(c => c.id === selectedDashboardCourseId);
            if(!course) { detail.innerHTML = ''; return; }
            const rows = getCourseProgressRows(course);
            detail.innerHTML = `
                <div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl overflow-hidden shadow">
                    <div class="p-5 border-b border-light-border dark:border-border">
                        <h4 class="font-black text-gray-900 dark:text-white">${safeText(course.title || 'Curso')}</h4>
                        <p class="text-xs text-gray-500 mt-1">${safeText(course.description || '')}</p>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-left text-sm">
                            <thead class="bg-gray-50 dark:bg-dark/50 text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider">
                                <tr><th class="p-4">Agente</th><th class="p-4">Wave</th><th class="p-4">Semana actual</th><th class="p-4">Día actual</th><th class="p-4 w-1/3">Porcentaje</th><th class="p-4 text-right">Estado</th></tr>
                            </thead>
                            <tbody class="divide-y divide-light-border dark:divide-border">
                                ${rows.map(r => `
                                    <tr class="hover:bg-gray-50 dark:hover:bg-dark/40">
                                        <td class="p-4 font-bold text-gray-900 dark:text-white">${safeText(r.agent.name || r.agent.email || 'Agente')}</td>
                                        <td class="p-4 text-gray-500">${safeText(r.wave?.name || '-')}</td>
                                        <td class="p-4">${safeText(r.next?.week?.title || 'Sin semana')}</td>
                                        <td class="p-4">${safeText(r.next?.day?.title || 'Sin día')}</td>
                                        <td class="p-4"><div class="flex items-center gap-3"><div class="flex-1 bg-gray-200 dark:bg-dark h-2 rounded-full overflow-hidden"><div class="bg-accent h-full" style="width:${r.pct}%"></div></div><span class="text-xs font-black text-accent w-10">${r.pct}%</span></div></td>
                                        <td class="p-4 text-right text-xs"><span class="px-2 py-1 rounded ${r.pct === 100 ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'} font-bold">${r.pct === 100 ? 'Completado' : 'En capacitación'}</span>${r.latestClosure ? `<div class="text-gray-500 mt-1">Asistencia: ${safeText(r.latestClosure.attendance[r.agent.id]?.status || '-')}</div>` : ''}</td>
                                    </tr>
                                `).join('') || `<tr><td colspan="6" class="p-6 text-center text-gray-500">Sin agentes asignados a este curso.</td></tr>`}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        function getCourseDayItems(course) {
            const items = [];
            (course.weeks || []).forEach((week, wIdx) => (week.days || []).forEach((day, dIdx) => {
                const closure = findDayClosure(course.id, wIdx, dIdx, null, week.title || `Semana ${wIdx + 1}`, day.title || `Dia ${dIdx + 1}`);
                items.push({ course, week, day, wIdx, dIdx, closure, key: `${course.id}:${wIdx}:${dIdx}` });
            }));
            return items;
        }

        window.selectDashboardDay = (key) => {
            selectedDashboardDayKey = key;
            renderDashboardCourseDetail();
        };

        function renderDashboardCourseDetail() {
            const detail = document.getElementById('dashboard-course-detail');
            if(!detail) return;
            const course = localCourses.find(c => c.id === selectedDashboardCourseId);
            if(!course) { detail.innerHTML = ''; return; }
            const rows = getCourseProgressRows(course);
            const dayItems = getCourseDayItems(course);
            if(dayItems.length && !dayItems.some(item => item.key === selectedDashboardDayKey)) {
                selectedDashboardDayKey = (dayItems.find(item => !item.closure) || dayItems[0]).key;
            }
            const selectedDay = dayItems.find(item => item.key === selectedDashboardDayKey);
            const attendance = Object.values(selectedDay?.closure?.attendance || {});
            const present = attendance.filter(a => a.status === 'presente').length;
            const absent = attendance.filter(a => a.status === 'ausente').length;
            const late = attendance.filter(a => a.status === 'tardanza').length;
            const completedDays = dayItems.filter(item => item.closure).length;
            const courseAvg = rows.length ? Math.round(rows.reduce((sum, r) => sum + r.pct, 0) / rows.length) : 0;
            detail.innerHTML = `
                <div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl overflow-hidden shadow">
                    <div class="p-5 border-b border-light-border dark:border-border">
                        <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                            <div>
                                <h4 class="font-black text-gray-900 dark:text-white">${safeText(course.title || 'Curso')}</h4>
                                <p class="text-xs text-gray-500 mt-1">${safeText(course.description || '')}</p>
                            </div>
                            <div class="grid grid-cols-3 gap-2 text-center min-w-full lg:min-w-[360px]">
                                <div class="bg-gray-50 dark:bg-dark/40 rounded-lg p-3"><div class="text-[10px] uppercase font-black text-gray-400">Progreso</div><div class="text-xl font-black text-accent">${courseAvg}%</div></div>
                                <div class="bg-gray-50 dark:bg-dark/40 rounded-lg p-3"><div class="text-[10px] uppercase font-black text-gray-400">Dias</div><div class="text-xl font-black text-success">${completedDays}/${dayItems.length}</div></div>
                                <div class="bg-gray-50 dark:bg-dark/40 rounded-lg p-3"><div class="text-[10px] uppercase font-black text-gray-400">Agentes</div><div class="text-xl font-black text-warning">${rows.length}</div></div>
                            </div>
                        </div>
                    </div>
                    <div class="p-5 space-y-5">
                        <div>
                            <div class="flex items-center justify-between mb-3">
                                <h5 class="text-sm font-black text-gray-900 dark:text-white">Ruta de capacitacion</h5>
                                <div class="flex gap-3 text-[11px] font-bold text-gray-500">
                                    <span><i class="fa-solid fa-circle text-success mr-1"></i>Finalizado</span>
                                    <span><i class="fa-solid fa-circle text-warning mr-1"></i>Pendiente</span>
                                </div>
                            </div>
                            <div class="space-y-3">
                                ${(course.weeks || []).map((week, wIdx) => `
                                    <div class="border border-light-border dark:border-border rounded-lg p-3">
                                        <div class="text-xs uppercase tracking-widest font-black text-gray-400 mb-2">${safeText(week.title || `Semana ${wIdx + 1}`)}</div>
                                        <div class="flex flex-wrap gap-2">
                                            ${(week.days || []).map((day, dIdx) => {
                                                const item = dayItems.find(x => x.wIdx === wIdx && x.dIdx === dIdx);
                                                const isSelected = item?.key === selectedDashboardDayKey;
                                                const done = Boolean(item?.closure);
                                                return `<button onclick="window.selectDashboardDay('${safeText(item?.key || `${course.id}:${wIdx}:${dIdx}`)}')" class="flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-bold transition ${isSelected ? 'border-accent bg-accent/10 text-accent' : 'border-light-border dark:border-border text-gray-600 dark:text-gray-300 hover:border-accent'}">
                                                    <i class="fa-solid fa-circle ${done ? 'text-success' : 'text-warning'}"></i>
                                                    ${safeText(day.title || `Dia ${dIdx + 1}`)}
                                                </button>`;
                                            }).join('') || `<span class="text-xs text-gray-500">Sin dias.</span>`}
                                        </div>
                                    </div>
                                `).join('') || `<div class="text-sm text-gray-500">Este curso no tiene semanas configuradas.</div>`}
                            </div>
                        </div>

                        ${selectedDay ? `
                            <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
                                <div class="xl:col-span-1 bg-gray-50 dark:bg-dark/40 border border-light-border dark:border-border rounded-xl p-4">
                                    <div class="text-xs uppercase tracking-widest font-black text-gray-400 mb-1">Detalle del dia</div>
                                    <h5 class="font-black text-gray-900 dark:text-white">${safeText(selectedDay.day?.title || `Dia ${selectedDay.dIdx + 1}`)}</h5>
                                    <p class="text-xs text-gray-500 mt-1">${safeText(selectedDay.week?.title || `Semana ${selectedDay.wIdx + 1}`)}</p>
                                    <div class="mt-4 space-y-2 text-sm">
                                        <div>Estado: <span class="font-black ${selectedDay.closure ? 'text-success' : 'text-warning'}">${selectedDay.closure ? 'Finalizado' : 'Pendiente'}</span></div>
                                        <div>Trainer: <strong>${safeText(selectedDay.closure?.trainerName || '-')}</strong></div>
                                        <div>Fecha: <strong>${selectedDay.closure?.date ? safeText(new Date(selectedDay.closure.date).toLocaleString()) : '-'}</strong></div>
                                        <div>${selectedDay.closure ? `<button onclick="window.showAttendanceDetail('${safeText(selectedDay.closure.id)}')" class="text-accent font-black hover:underline">Asistencia: P:${present} A:${absent} T:${late}</button>` : `Asistencia: <strong>Sin cierre</strong>`}</div>
                                    </div>
                                    <div class="mt-4 pt-4 border-t border-light-border dark:border-border">
                                        <div class="text-xs uppercase tracking-widest font-black text-gray-400 mb-2">Comentario trainer</div>
                                        <p class="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap">${safeText(selectedDay.closure?.comments || 'Aun no hay comentario registrado para este dia.')}</p>
                                    </div>
                                </div>
                                <div class="xl:col-span-2 border border-light-border dark:border-border rounded-xl overflow-hidden">
                                    <div class="px-4 py-3 bg-gray-50 dark:bg-dark/40 border-b border-light-border dark:border-border text-xs uppercase tracking-widest font-black text-gray-500">Agentes asignados</div>
                                    <div class="divide-y divide-light-border dark:divide-border">
                                        ${rows.map(r => {
                                            const dayActs = r.acts.filter(x => x.wIdx === selectedDay.wIdx && x.dIdx === selectedDay.dIdx);
                                            const dayDone = dayActs.filter(x => hasActivityProgress(r.agent.id, course.id, x.wIdx, x.dIdx, x.aIdx)).length;
                                            const dayPct = dayActs.length ? Math.round((dayDone / dayActs.length) * 100) : 0;
                                            const attStatus = selectedDay.closure?.attendance?.[r.agent.id]?.status;
                                            return `<div class="p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                                                <div>
                                                    <div class="font-black text-gray-900 dark:text-white">${safeText(r.agent.name || r.agent.email || 'Agente')}</div>
                                                    <div class="text-xs text-gray-500">${safeText(r.wave?.name || 'Sin wave')} - ${safeText(r.next?.week?.title || 'Sin avance')} / ${safeText(r.next?.day?.title || 'Sin dia')}</div>
                                                </div>
                                                <div class="flex items-center gap-3 md:min-w-[320px]">
                                                    <div class="flex-1 bg-gray-200 dark:bg-dark h-2 rounded-full overflow-hidden"><div class="${dayPct === 100 ? 'bg-success' : 'bg-accent'} h-full" style="width:${dayPct}%"></div></div>
                                                    <span class="text-xs font-black text-accent w-10">${dayPct}%</span>
                                                    <span class="text-[11px] px-2 py-1 rounded font-black ${attStatus === 'presente' ? 'bg-success/15 text-success' : attStatus === 'ausente' ? 'bg-danger/15 text-danger' : attStatus === 'tardanza' ? 'bg-warning/15 text-warning' : 'bg-gray-200 dark:bg-dark text-gray-500'}">${safeText(attStatus || 'sin cierre')}</span>
                                                </div>
                                            </div>`;
                                        }).join('') || `<div class="p-6 text-center text-gray-500">Sin agentes asignados a este curso.</div>`}
                                    </div>
                                </div>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }

        window.showAttendanceDetail = (closureId) => {
            const closure = localDayClosures.find(c => c.id === closureId);
            if(!closure) return;
            const groups = { presente: [], ausente: [], tardanza: [] };
            Object.values(closure.attendance || {}).forEach(a => {
                const key = groups[a.status] ? a.status : 'presente';
                groups[key].push(a);
            });
            document.getElementById('attendance-detail-context').innerText = `${closure.courseTitle || ''} · ${closure.weekTitle || ''} · ${closure.dayTitle || ''}`;
            document.getElementById('attendance-detail-body').innerHTML = `
                <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                    ${Object.entries(groups).map(([status, agents]) => `
                        <div class="border border-light-border dark:border-border rounded-xl p-4">
                            <div class="text-xs uppercase tracking-widest font-black ${status === 'presente' ? 'text-success' : status === 'ausente' ? 'text-danger' : 'text-warning'} mb-3">${status} (${agents.length})</div>
                            <div class="space-y-2">${agents.map(a => `<div class="text-sm font-bold text-gray-900 dark:text-white">${safeText(a.name || a.email || 'Agente')}</div>`).join('') || `<div class="text-sm text-gray-400">Sin agentes</div>`}</div>
                        </div>
                    `).join('')}
                </div>
                <div class="bg-gray-50 dark:bg-dark/40 border border-light-border dark:border-border rounded-xl p-4">
                    <div class="text-xs uppercase tracking-widest font-black text-gray-500 mb-2">Comentarios del trainer</div>
                    <div class="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">${safeText(closure.comments || 'Sin comentarios')}</div>
                </div>
            `;
            document.getElementById('modal-attendance-detail').classList.remove('hidden');
        };

        function renderAdminSupervision() {
            const dash = document.getElementById('admin-supervision-panel');
            const coursePanel = document.getElementById('admin-course-supervision-panel');
            const closures = [...localDayClosures].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
            if(dash) {
                dash.innerHTML = `
                    <h3 class="text-lg font-bold text-gray-900 dark:text-white mb-4"><i class="fa-solid fa-eye mr-2 text-accent"></i>Resumen de Supervisión</h3>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl p-5"><div class="text-xs uppercase text-gray-400 font-bold">Cierres de día</div><div class="text-3xl font-black text-gray-900 dark:text-white">${closures.length}</div></div>
                        <div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl p-5"><div class="text-xs uppercase text-gray-400 font-bold">Sesiones UPANAHOOT</div><div class="text-3xl font-black text-accent">${localUPANAHOOTSessions.filter(s => s.status === 'podium' || s.finishedAt).length}</div></div>
                        <div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl p-5"><div class="text-xs uppercase text-gray-400 font-bold">Comentarios trainer</div><div class="text-3xl font-black text-warning">${closures.filter(c => c.comments).length}</div></div>
                    </div>
                `;
            }
            if(!coursePanel) return;
            coursePanel.innerHTML = `
                <h3 class="text-lg font-bold text-gray-900 dark:text-white mb-4"><i class="fa-solid fa-clipboard-list mr-2 text-accent"></i>Supervisión Admin por Curso</h3>
                <div class="space-y-4">
                    ${localCourses.map(course => {
                        const courseClosures = closures.filter(c => c.courseId === course.id);
                        return `<div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl p-5 shadow">
                            <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
                                <div>
                                    <h4 class="font-black text-gray-900 dark:text-white">${safeText(course.title || 'Curso')}</h4>
                                    <p class="text-xs text-gray-500">${safeText(course.description || 'Sin descripción')}</p>
                                </div>
                                <span class="text-xs font-black text-accent">${courseClosures.length} cierre(s)</span>
                            </div>
                            <div class="space-y-3">
                                ${(course.weeks || []).map((week, wIdx) => `
                                    <div class="border border-light-border dark:border-border rounded-lg p-3">
                                        <div class="font-bold text-sm text-gray-900 dark:text-white mb-2">${safeText(week.title || `Semana ${wIdx + 1}`)}</div>
                                        ${(week.days || []).map((day, dIdx) => {
                                            const closure = findDayClosure(course.id, wIdx, dIdx, null, week.title || `Semana ${wIdx + 1}`, day.title || `Dia ${dIdx + 1}`);
                                            const attendance = Object.values(closure?.attendance || {});
                                            const present = attendance.filter(a => a.status === 'presente').length;
                                            const absent = attendance.filter(a => a.status === 'ausente').length;
                                            const late = attendance.filter(a => a.status === 'tardanza').length;
                                            const hoots = localUPANAHOOTSessions.filter(s => s.kahootId && s.courseId === course.id && Number(s.wIdx) === wIdx && Number(s.dIdx) === dIdx);
                                            return `<div class="bg-gray-50 dark:bg-dark/40 rounded p-3 mb-2 text-xs">
                                                <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                                                    <div class="font-bold text-gray-900 dark:text-white">${safeText(day.title || `Día ${dIdx + 1}`)}</div>
                                                    <div class="text-gray-500">${closure ? safeText(new Date(closure.date).toLocaleString()) : 'Sin cierre'}</div>
                                                </div>
                                                <div class="grid grid-cols-1 md:grid-cols-3 gap-2 mt-2 text-gray-600 dark:text-gray-300">
                                                    <div>Trainer: <strong>${safeText(closure?.trainerName || '-')}</strong></div>
                                                    <div>${closure ? `<button onclick="window.showAttendanceDetail(\'${safeText(closure.id)}\')" class="text-accent font-black hover:underline">Asistencia: P:${present} A:${absent} T:${late}</button>` : `Asistencia: <strong>Sin cierre</strong>`}</div>
                                                    <div class="md:col-span-2">Comentarios: <strong>${closure?.comments ? safeText(closure.comments) : '-'}</strong></div>
                                                </div>
                                            </div>`;
                                        }).join('') || `<div class="text-xs text-gray-500">Sin días.</div>`}
                                    </div>
                                `).join('') || `<div class="text-xs text-gray-500">Sin semanas.</div>`}
                            </div>
                        </div>`;
                    }).join('') || `<div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl p-5 text-sm text-gray-500">Sin cursos registrados.</div>`}
                </div>
            `;
        }

        function renderTrainerUPANAHOOTResults() {
            const container = document.getElementById('trainer-upanahoot-results');
            if(!container) return;
            const finished = localUPANAHOOTSessions
                .filter(s => s.status === 'podium' || s.finishedAt || (s.summary && s.summary.length))
                .sort((a, b) => new Date(b.finishedAt || b.updatedAt || b.createdAt || 0) - new Date(a.finishedAt || a.updatedAt || a.createdAt || 0));
            if(finished.length === 0) {
                container.innerHTML = `<div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl p-5 text-sm text-gray-500">Aún no hay resultados UPANAHOOT finalizados.</div>`;
                return;
            }
            container.innerHTML = finished.map(s => {
                const k = localUPANAHOOTs.find(x => x.id === s.kahootId);
                const summary = (s.summary && s.summary.length) ? s.summary : buildUPANAHOOTPodium(s, k);
                return `
                    <div class="bg-light-surface dark:bg-surface border border-light-border dark:border-border rounded-xl p-5 shadow">
                        <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
                            <div>
                                <h4 class="font-black text-gray-900 dark:text-white">${safeText(k?.title || s.upanahootTitle || 'UPANAHOOT')}</h4>
                                <p class="text-xs text-gray-500">PIN ${safeText(s.pin || '')} · ${safeText(new Date(s.finishedAt || s.updatedAt || s.createdAt || Date.now()).toLocaleString())}</p>
                            </div>
                            <span class="text-xs font-black px-3 py-1 rounded-full bg-warning/20 text-warning">${summary.length} participantes</span>
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
                            ${summary.slice(0, 3).map((p, idx) => `
                                <div class="border border-light-border dark:border-border rounded-lg p-3">
                                    <div class="text-xs font-black text-gray-400">#${idx + 1}</div>
                                    <div class="font-bold text-gray-900 dark:text-white truncate">${safeText(p.name)}</div>
                                    <div class="text-warning font-black">${Number(p.score || 0)} pts</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            }).join('');
        }

        
        window.startPresentation = (wId, cId, wIdx, dIdx) => {
            const wave = localWaves.find(w => w.id === wId);
            const course = localCourses.find(c => c.id === cId);
            const week = course.weeks[wIdx];
            const day = week.days[dIdx];

            if(!day.activities || day.activities.length === 0) return alert("Día vacío.");

            presState = { waveId: wId, waveName: wave.name, courseId: cId, courseTitle: course.title, wIdx, weekTitle: week.title, dIdx, dayTitle: day.title, activities: day.activities, currentAIdx: 0 };
            presentationReturnState = null;
            presentationSearchTerm = "";

            document.getElementById('pres-course-title').innerText = course.title;
            document.getElementById('pres-wave-title').innerText = `${wave.name} | ${week.title} - ${day.title}`;
            
            document.getElementById('presentation-view').classList.remove('hidden');
            document.getElementById('presentation-view').classList.add('flex');
            setTopUserMenuVisible(false);
            window.togglePresentationSidebar(false);
            
            renderPresentationSidebar();
            renderCurrentSlide();
        };

        function stopPresentationMedia() {
            const content = document.getElementById('pres-slide-container');
            if(!content) return;
            content.querySelectorAll('video, audio').forEach(media => {
                media.pause();
                media.currentTime = 0;
                media.removeAttribute('src');
                media.querySelectorAll('source').forEach(source => source.removeAttribute('src'));
                media.load();
            });
            content.querySelectorAll('iframe').forEach(frame => {
                try {
                    frame.contentWindow?.postMessage('{"event":"command","func":"stopVideo","args":""}', '*');
                } catch {}
                frame.src = 'about:blank';
                frame.removeAttribute('srcdoc');
                frame.remove();
            });
            content.innerHTML = '';
            presState.activities = [];
            presState.currentAIdx = 0;
        }

        window.closePresentation = () => {
            stopPresentationMedia();
            document.getElementById('presentation-view').classList.add('hidden');
            document.getElementById('presentation-view').classList.remove('flex');
            if(document.getElementById('upanahoot-execution-view')?.classList.contains('hidden')) setTopUserMenuVisible(true);
        };
        window.togglePresentationSidebar = (forceOpen = null) => {
            const sidebar = document.getElementById('pres-sidebar');
            if(!sidebar) return;
            const shouldOpen = forceOpen === null ? !sidebar.classList.contains('open') : forceOpen;
            sidebar.classList.toggle('open', shouldOpen);
        };

        function presentationSearchResults(course, query) {
            const normalized = normalizeSearch(query);
            if(!normalized) return [];
            const results = [];
            (course.weeks || []).forEach((week, wIdx) => (week.days || []).forEach((day, dIdx) => (day.activities || []).forEach((act, aIdx) => {
                if(activitySearchText(course, week, day, act).includes(normalized)) results.push({ week, day, act, wIdx, dIdx, aIdx });
            })));
            return results;
        }

        window.setPresentationSearch = (value = "") => {
            presentationSearchTerm = String(value || "");
            clearTimeout(presentationSearchRenderTimer);
            if(!presentationSearchTerm) {
                renderPresentationSidebar();
                return;
            }
            presentationSearchRenderTimer = setTimeout(() => {
                renderPresentationSidebar();
                requestAnimationFrame(() => {
                    const input = document.getElementById('presentation-search-input');
                    if(input) {
                        input.focus();
                        const pos = input.value.length;
                        input.setSelectionRange(pos, pos);
                    }
                });
            }, 180);
        };

        window.jumpToPresentationActivity = (wIdx, dIdx, aIdx) => {
            const course = localCourses.find(c => c.id === presState.courseId);
            const week = course?.weeks?.[wIdx];
            const day = week?.days?.[dIdx];
            if(!course || !week || !day || !day.activities?.[aIdx]) return;
            if(!presentationReturnState) {
                presentationReturnState = {
                    wIdx: presState.wIdx,
                    dIdx: presState.dIdx,
                    currentAIdx: presState.currentAIdx
                };
            }
            presState.wIdx = Number(wIdx);
            presState.weekTitle = week.title;
            presState.dIdx = Number(dIdx);
            presState.dayTitle = day.title;
            presState.activities = day.activities || [];
            presState.currentAIdx = Number(aIdx);
            document.getElementById('pres-wave-title').innerText = `${presState.waveName} | ${week.title} - ${day.title}`;
            window.togglePresentationSidebar(false);
            renderCurrentSlide(true);
        };

        window.returnToPresentationAnchor = () => {
            if(!presentationReturnState) return;
            const course = localCourses.find(c => c.id === presState.courseId);
            const week = course?.weeks?.[presentationReturnState.wIdx];
            const day = week?.days?.[presentationReturnState.dIdx];
            if(!course || !week || !day) {
                presentationReturnState = null;
                return;
            }
            presState.wIdx = presentationReturnState.wIdx;
            presState.weekTitle = week.title;
            presState.dIdx = presentationReturnState.dIdx;
            presState.dayTitle = day.title;
            presState.activities = day.activities || [];
            presState.currentAIdx = Math.min(presentationReturnState.currentAIdx, Math.max((day.activities || []).length - 1, 0));
            presentationReturnState = null;
            document.getElementById('pres-wave-title').innerText = `${presState.waveName} | ${week.title} - ${day.title}`;
            renderCurrentSlide(true);
        };

        function renderPresentationSidebar() {
            const course = localCourses.find(c => c.id === presState.courseId);
            const nav = document.getElementById('pres-sidebar-nav');
            if(!course || !nav) return;
            
            const results = presentationSearchResults(course || {}, presentationSearchTerm);
            let html = `
                <div class="sticky top-0 z-10 bg-light-surface dark:bg-surface pb-3">
                    <div class="relative">
                        <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs"></i>
                        <input id="presentation-search-input" type="search" value="${safeText(presentationSearchTerm)}" oninput="window.setPresentationSearch(this.value)" placeholder="Buscar en todo el curso..." class="w-full bg-gray-50 dark:bg-dark/40 border border-light-border dark:border-border rounded-xl py-2.5 pl-9 pr-9 text-xs outline-none focus:border-accent text-gray-900 dark:text-white">
                        ${presentationSearchTerm ? `<button onclick="window.setPresentationSearch('')" class="absolute right-3 top-1/2 -translate-y-1/2 text-accent text-xs"><i class="fa-solid fa-xmark"></i></button>` : ''}
                    </div>
                    ${presentationReturnState ? `<button onclick="window.returnToPresentationAnchor()" class="mt-2 w-full bg-accent/10 text-accent border border-accent/20 rounded-lg px-3 py-2 text-xs font-black"><i class="fa-solid fa-rotate-left mr-1"></i>Volver a donde estaba</button>` : ''}
                </div>
            `;
            if(presentationSearchTerm) {
                html += `
                    <div class="mb-4">
                        <div class="text-[10px] uppercase tracking-widest font-black text-gray-400 mb-2">${results.length} resultado(s)</div>
                        <div class="space-y-1">
                            ${results.map(item => `
                                <button onclick="window.jumpToPresentationActivity(${item.wIdx}, ${item.dIdx}, ${item.aIdx})" class="w-full text-left rounded-lg border border-light-border dark:border-border hover:border-accent hover:bg-accent/5 p-2 text-xs transition">
                                    <div class="font-black text-gray-900 dark:text-white truncate">${safeText(item.act.title || 'Actividad sin título')}</div>
                                    <div class="text-[10px] text-gray-500 mt-1 truncate">${safeText(item.week.title || '')} · ${safeText(item.day.title || '')} · ${safeText(item.act.type || '')}</div>
                                </button>
                            `).join('') || `<div class="text-xs text-gray-400 p-2">Sin coincidencias.</div>`}
                        </div>
                    </div>
                `;
            }
            (course.weeks || []).forEach((w, wi) => {
                html += `<div class="font-bold text-xs text-gray-500 uppercase tracking-widest mt-4 mb-2">${w.title}</div>`;
                (w.days || []).forEach((d, di) => {
                    const isCurrentDay = (wi === presState.wIdx && di === presState.dIdx);
                    html += `
                        <div class="ml-2 border-l-2 ${isCurrentDay ? 'border-accent' : 'border-light-border dark:border-border'} pl-3 mb-4">
                            <div class="text-sm font-semibold text-gray-900 dark:text-white mb-2">${d.title}</div>
                            <div class="space-y-1">
                                ${(d.activities || []).map((a, ai) => {
                                    const isCurrentAct = isCurrentDay && (ai === presState.currentAIdx);
                                    const activeClass = isCurrentAct ? 'bg-accent/10 text-accent font-bold border-accent/30' : 'hover:bg-gray-50 dark:hover:bg-dark border-transparent text-gray-600 dark:text-gray-400';
                                    
                                    const clickHandler = isCurrentDay ? `onclick="window.goToSlide(${ai})"` : '';
                                    
                                    return `<button ${clickHandler} class="w-full text-left text-xs p-2 rounded border transition ${activeClass} truncate block">
                                        <i class="fa-solid fa-angle-right mr-1 opacity-50"></i> ${a.title}
                                    </button>`;
                                }).join('')}
                            </div>
                        </div>
                    `;
                });
            });
            nav.innerHTML = html;
        }

        function scrollPresentationToTop() {
            document.getElementById('pres-slide-container')?.scrollIntoView({ block: 'start' });
            document.getElementById('presentation-view')?.scrollTo({ top: 0, behavior: 'auto' });
        }

        window.goToSlide = (idx) => { presState.currentAIdx = idx; window.togglePresentationSidebar(false); renderCurrentSlide(true); };
        window.navigatePresentation = (step) => {
            const newIdx = presState.currentAIdx + step;
            if(newIdx >= 0 && newIdx < presState.activities.length) { presState.currentAIdx = newIdx; renderCurrentSlide(true); }
        };

        window.toggleImageFullscreen = (imgEl) => {
            if(!document.fullscreenElement) { imgEl.requestFullscreen().catch(err => alert("Error fullscreen")); } 
            else { document.exitFullscreen(); }
        };

        function renderCurrentSlide(resetScroll = false) {
            const act = presState.activities[presState.currentAIdx];
            const total = presState.activities.length;
            
            document.getElementById('pres-counter').innerText = `Actividad ${presState.currentAIdx + 1} de ${total}`;
            document.getElementById('pres-progress-bar').style.width = `${((presState.currentAIdx + 1) / total) * 100}%`;
            
            document.getElementById('btn-pres-prev').style.visibility = presState.currentAIdx === 0 ? 'hidden' : 'visible';
            document.getElementById('btn-pres-next').style.visibility = presState.currentAIdx === total - 1 ? 'hidden' : 'visible';
            document.getElementById('btn-pres-finish').classList.toggle('hidden', presState.currentAIdx !== total - 1);

            renderPresentationSidebar();
            let mediaHtml = '';
            
            if (act.type === 'video') {
                const videoUrl = act.url || act.youtube || act.externalUrl || '';
                const embedFrame = renderEmbedFrame(act.embedCode || '', act.title || 'Video incrustado', 'projection-video-frame');
                if(embedFrame) {
                    mediaHtml = `<div class="projection-block rounded-xl overflow-hidden shadow-2xl border border-light-border dark:border-border bg-black">${embedFrame}</div>`;
                } else if(videoUrl && isDirectVideoUrl(videoUrl)) {
                    mediaHtml = `<div class="projection-block rounded-xl overflow-hidden shadow-2xl bg-black"><video controls class="projection-video-frame"><source src="${safeText(videoUrl)}"></video></div>`;
                } else if(videoUrl) {
                    mediaHtml = `<div class="projection-block rounded-xl overflow-hidden shadow-2xl border border-light-border dark:border-border bg-white">
                                    <iframe src="${safeText(videoUrl)}" class="projection-video-frame" allowfullscreen title="${safeText(act.title || 'Video externo')}"></iframe>
                                  </div>
                                  <div class="text-center text-xs text-gray-500 mt-2">Si el visor externo no carga, <a href="${safeText(videoUrl)}" target="_blank" class="text-accent font-black underline">abrir enlace público</a></div>`;
                }
            } else if (act.type === 'pdf' && act.url) {
                mediaHtml = `<div class="projection-block projection-media rounded-xl overflow-hidden shadow-2xl border border-light-border dark:border-border bg-white">
                                <iframe src="${safeText(getPdfViewerUrl(act.url))}" class="projection-pdf-frame" title="${safeText(act.title || '')}"></iframe>
                             </div>`;
            } else if (act.type === 'imagen' && act.url) {
                mediaHtml = `<div class="projection-block projection-image-wrap bg-gray-50 dark:bg-dark/40 rounded-xl border border-light-border dark:border-border">
                                <img src="${safeText(act.url)}" onclick="window.toggleImageFullscreen(this)" class="projection-image rounded-lg cursor-pointer hover:opacity-95 transition" title="Clic para Pantalla Completa">
                             </div>`;
            } else if (act.type === 'kahoot') {
                const kData = localUPANAHOOTs.find(k => k.id === act.kahootId);
                const kTitle = kData ? kData.title : "UPANAHOOT no encontrado";
                const kCount = kData ? kData.questions?.length : 0;
                mediaHtml = `
                    <div class="upanahoot-projection-card bg-[#46178f] text-white p-5 md:p-8 rounded-2xl text-center shadow-2xl my-3 mx-auto">
                        <div class="text-3xl md:text-5xl font-black mb-4">UPANA<span class="text-cyan-200">HOOT</span></div>
                        <h3 class="text-xl md:text-2xl font-bold mb-2">${safeText(kTitle)}</h3>
                        <p class="text-base md:text-lg opacity-80 mb-6">${kCount} Preguntas Evaluativas</p>
                        ${kData ? `<button onclick="window.launchUPANAHOOTExecution('${safeText(act.kahootId)}')" class="bg-white text-[#46178f] hover:bg-gray-100 font-black text-lg md:text-2xl py-4 px-6 md:px-12 rounded shadow-xl transition transform hover:scale-105">INICIAR DINÁMICA</button>` : `<span class="text-red-300">El UPANAHOOT asociado fue eliminado del banco.</span>`}
                    </div>`;
            }

            const textHtml = act.description && act.type !== 'kahoot' ? `
                        <div class="projection-text-block learning-content bg-gray-50 dark:bg-dark/40 border border-light-border dark:border-border rounded-xl p-5 md:p-6 text-left text-gray-800 dark:text-gray-200 text-base md:text-lg leading-relaxed shadow-inner">
                            ${renderPresentationRichHtml(act.description)}
                        </div>
                    ` : '';
            const orderedContent = act.contentOrder === 'text-first' ? `${textHtml}${mediaHtml}` : `${mediaHtml}${textHtml}`;

            const slideHtml = `
                <div class="bg-white/95 dark:bg-surface/95 border border-light-border dark:border-border rounded-xl shadow-sm p-3 md:p-4 text-left mb-3 shrink-0">
                    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                        <h2 class="text-xl md:text-3xl font-black text-gray-900 dark:text-white leading-tight tracking-tight">${act.title}</h2>
                        <span class="inline-block w-max px-3 py-1 rounded-full bg-accent/10 text-accent text-[11px] font-bold uppercase tracking-wider border border-accent/20">${act.type} ${act.duration ? `• ${act.duration} Min` : ''}</span>
                    </div>
                    ${act.objectives ? `<p class="text-warning text-sm md:text-base font-medium mt-2"><i class="fa-solid fa-bullseye mr-2"></i>${act.objectives}</p>` : ''}
                </div>
                
                <div class="projection-stack">
                    ${orderedContent}
                </div>
                
                ${act.notes ? `
                    <div class="mt-6 flex justify-center">
                        <div class="relative w-full max-w-3xl shadow-2xl">
                            <div class="trainer-notes-trigger bg-warning text-dark text-xs font-bold uppercase tracking-wider py-2 px-6 rounded-t-xl mx-auto w-max cursor-pointer opacity-80 hover:opacity-100 transition shadow-lg"><i class="fa-solid fa-chalkboard-user mr-2"></i>Ver Notas del Trainer</div>
                            <div class="trainer-notes-container bg-warning rounded-b-xl rounded-t-none text-dark shadow-2xl w-full border-t border-yellow-600/30">
                                <div class="p-6 text-sm font-medium leading-relaxed">
                                    ${toHtml(act.notes)}
                                </div>
                            </div>
                        </div>
                    </div>
                ` : ''}
            `;
            document.getElementById('pres-slide-container').innerHTML = slideHtml;
            if(resetScroll) requestAnimationFrame(scrollPresentationToTop);
        }

        window.markDayCompleted = async () => {
            const agentIdsInWave = localAssignments.filter(a => a.type === 'agent_wave' && a.assignId === presState.waveId).map(a => a.targetId);
            const directAgentIds = localAssignments.filter(a => a.type === 'agent_course' && (a.courseId || a.assignId) === presState.courseId).map(a => a.agentId || a.targetId);
            const agents = [...new Set([...agentIdsInWave, ...directAgentIds])].map(id => localUsers.find(u => u.id === id)).filter(Boolean);
            dayClosureState = { agents };
            document.getElementById('day-close-context').innerText = `${presState.courseTitle} · ${presState.weekTitle} · ${presState.dayTitle}`;
            document.getElementById('day-close-comments').value = '';
            document.getElementById('day-close-agents').innerHTML = agents.map(agent => `
                <div class="bg-gray-50 dark:bg-dark/40 border border-light-border dark:border-border rounded-lg p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div>
                        <div class="font-bold text-gray-900 dark:text-white">${safeText(agent.name || agent.email || 'Agente')}</div>
                        <div class="text-xs text-gray-500">${safeText(agent.email || '')}</div>
                    </div>
                    <div class="flex gap-2" data-agent-attendance="${safeText(agent.id)}">
                        ${['presente','ausente','tardanza'].map(status => `
                            <label class="cursor-pointer text-xs font-bold border border-light-border dark:border-border rounded px-3 py-2">
                                <input type="radio" name="attendance_${safeText(agent.id)}" value="${status}" ${status === 'presente' ? 'checked' : ''} class="mr-1 accent-success">
                                ${status.toUpperCase()}
                            </label>
                        `).join('')}
                    </div>
                </div>
            `).join('') || `<div class="text-sm text-gray-500">No hay agentes asignados a esta Wave.</div>`;
            document.getElementById('modal-day-close').classList.remove('hidden');
        };

        window.saveDayClosure = async () => {
            if(!dayClosureState) return;
            const btn = document.getElementById('btn-pres-finish');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Registrando...'; btn.disabled = true;
            const attendance = {};
            dayClosureState.agents.forEach(agent => {
                const selected = document.querySelector(`input[name="attendance_${agent.id}"]:checked`);
                attendance[agent.id] = {
                    userId: agent.id,
                    name: agent.name || agent.email || 'Agente',
                    email: agent.email || '',
                    status: selected?.value || 'presente'
                };
            });

            const promises = [];
            dayClosureState.agents.forEach(agent => {
                presState.activities.forEach((act, aIdx) => {
                    const docId = progressKey(agent.id, presState.courseId, presState.wIdx, presState.dIdx, aIdx);
                    promises.push(setDoc(doc(db, "userProgress", docId), {
                        userId: agent.id,
                        courseId: presState.courseId,
                        weekId: presState.wIdx,
                        dayId: presState.dIdx,
                        activityId: aIdx,
                        status: "completed",
                        completionPercentage: 100,
                        lastAccess: new Date().toISOString(),
                        markedByTrainerId: currentUser.id
                    }));
                });
            });

            const closureId = `${presState.waveId}_${presState.courseId}_${presState.wIdx}_${presState.dIdx}_${Date.now()}`;
            promises.push(setDoc(doc(db, "dayClosures", closureId), {
                waveId: presState.waveId,
                waveName: presState.waveName,
                courseId: presState.courseId,
                courseTitle: presState.courseTitle,
                wIdx: presState.wIdx,
                weekTitle: presState.weekTitle,
                dIdx: presState.dIdx,
                dayTitle: presState.dayTitle,
                trainerId: currentUser.id,
                trainerName: currentUser.name || currentUser.email || 'Trainer',
                attendance,
                comments: document.getElementById('day-close-comments').value || '',
                date: new Date().toISOString()
            }));

            try {
                await Promise.all(promises);
                alert("Día completado, asistencia y comentarios guardados.");
                document.getElementById('modal-day-close').classList.add('hidden');
                window.closePresentation();
            } catch (err) { alert("Error: " + err.message); }
            finally {
                btn.innerHTML = '<i class="fa-solid fa-check-double"></i> Marcar Día Completado';
                btn.disabled = false;
            }
        };

        let upanahootExecState = { upanahoot: null, sessionId: null, pin: null, qIdx: -1, status: 'lobby', participants: {} };
        let upanahootTimerHandle = null;

        function getCurrentUPANAHOOTQuestion() {
            return upanahootExecState.upanahoot?.questions?.[Number(upanahootExecState.qIdx || 0)];
        }

        function prepareUPANAHOOTQuestionTiming() {
            const q = getCurrentUPANAHOOTQuestion();
            const seconds = Number(q?.time || 20);
            const now = Date.now();
            upanahootExecState.questionStartedAt = new Date(now).toISOString();
            upanahootExecState.questionEndsAt = new Date(now + seconds * 1000).toISOString();
        }

        function scheduleUPANAHOOTTimer() {
            if(upanahootTimerHandle) clearTimeout(upanahootTimerHandle);
            if(upanahootExecState.status !== 'question' || !upanahootExecState.sessionId) return;
            const remaining = getUPANAHOOTRemainingSeconds(upanahootExecState);
            if(remaining <= 0) {
                window.forceUPANAHOOTResults();
                return;
            }
            upanahootTimerHandle = setTimeout(() => {
                renderUPANAHOOTExecutionStep();
                scheduleUPANAHOOTTimer();
            }, 1000);
        }

        window.forceUPANAHOOTResults = async () => {
            if(upanahootExecState.status !== 'question' || !upanahootExecState.sessionId) return;
            upanahootExecState.status = 'results';
            await updateDoc(doc(db, "kahootSessions", upanahootExecState.sessionId), {
                status: 'results',
                updatedAt: new Date().toISOString()
            });
            renderUPANAHOOTExecutionStep();
        };

        window.launchUPANAHOOTExecution = async (kahootId) => {
            const k = localUPANAHOOTs.find(x => x.id === kahootId);
            if(!k) return;
            await Promise.all(localUPANAHOOTSessions
                .filter(s => !['closed', 'podium'].includes(s.status) && s.trainerId === (currentUser?.id || ''))
                .map(s => updateDoc(doc(db, "kahootSessions", s.id), { status: 'closed', closedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })));
            const pin = String(Math.floor(100000 + Math.random() * 900000));
            const sessionRef = doc(collection(db, "kahootSessions"));
            const sessionData = {
                kahootId,
                upanahootTitle: k.title || 'UPANAHOOT',
                pin,
                qIdx: -1,
                status: 'lobby',
                participants: {},
                createdAt: new Date().toISOString(),
                trainerId: currentUser?.id || '',
                trainerName: currentUser?.name || currentUser?.email || 'Trainer'
            };
            await setDoc(sessionRef, sessionData);
            upanahootExecState = { upanahoot: k, sessionId: sessionRef.id, ...sessionData };
            
            document.getElementById('k-exec-pin').innerText = "PIN: " + pin;
            document.getElementById('upanahoot-execution-view').classList.remove('hidden');
            document.getElementById('upanahoot-execution-view').classList.add('flex');
            setTopUserMenuVisible(false);
            
            renderUPANAHOOTExecutionStep();
        };

        window.closeUPANAHOOTExecution = async () => {
            if(await askConfirm("¿Cerrar dinámica interactiva?")) {
                if(upanahootExecState.sessionId) {
                    await updateDoc(doc(db, "kahootSessions", upanahootExecState.sessionId), { status: 'closed', closedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
                }
                document.getElementById('upanahoot-execution-view').classList.add('hidden');
                document.getElementById('upanahoot-execution-view').classList.remove('flex');
                if(upanahootTimerHandle) clearTimeout(upanahootTimerHandle);
                upanahootExecState = { upanahoot: null, sessionId: null, pin: null, qIdx: -1, status: 'lobby', participants: {} };
                if(document.getElementById('presentation-view')?.classList.contains('hidden')) setTopUserMenuVisible(true);
            }
        };

        window.advanceUPANAHOOT = async () => {
            if(upanahootExecState.status === 'lobby') { upanahootExecState.status = 'question'; upanahootExecState.qIdx = 0; }
            else if(upanahootExecState.status === 'question') { upanahootExecState.status = 'results'; }
            else if(upanahootExecState.status === 'results') {
                upanahootExecState.qIdx++;
                if(upanahootExecState.qIdx >= upanahootExecState.upanahoot.questions.length) upanahootExecState.status = 'podium';
                else upanahootExecState.status = 'question';
            }
            else if(upanahootExecState.status === 'podium') { await window.closeUPANAHOOTExecution(); return; }
            if(upanahootExecState.status === 'question') prepareUPANAHOOTQuestionTiming();
            
            if(upanahootExecState.sessionId) {
                const summary = upanahootExecState.status === 'podium'
                    ? buildUPANAHOOTPodium(upanahootExecState, upanahootExecState.upanahoot).map((p, idx) => ({ ...p, rank: idx + 1 }))
                    : null;
                await updateDoc(doc(db, "kahootSessions", upanahootExecState.sessionId), {
                    status: upanahootExecState.status,
                    qIdx: upanahootExecState.qIdx,
                    questionStartedAt: upanahootExecState.questionStartedAt || null,
                    questionEndsAt: upanahootExecState.questionEndsAt || null,
                    ...(summary ? { summary, finishedAt: new Date().toISOString() } : {}),
                    updatedAt: new Date().toISOString()
                });
            }
            renderUPANAHOOTExecutionStep();
        };
        function renderUPANAHOOTExecutionStep() {
            const container = document.getElementById('k-exec-content');
            const btnNext = document.getElementById('btn-k-exec-next');
            const statusLabel = document.getElementById('k-exec-status');
            document.getElementById('k-exec-pin').innerText = "PIN: " + (upanahootExecState.pin || "000000");
            if(upanahootExecState.status !== 'question' && upanahootTimerHandle) clearTimeout(upanahootTimerHandle);

            if(upanahootExecState.status === 'lobby') {
                const participants = getSessionParticipants(upanahootExecState);
                container.innerHTML = `<h2 class="text-5xl font-black text-gray-800 dark:text-white mb-3 text-center">Únete con el PIN</h2>
                                       <div class="text-6xl font-black text-[#46178f] bg-white px-10 py-4 rounded-xl shadow mb-8">${safeText(upanahootExecState.pin || '')}</div>
                                       <div class="text-sm font-bold text-gray-500 dark:text-gray-300 mb-4">${participants.length} participante(s) conectado(s)</div>
                                       <div class="flex gap-4 flex-wrap justify-center">
                                            ${participants.length ? participants.map(p => `<div class="bg-white dark:bg-gray-800 px-6 py-3 rounded shadow text-xl font-bold dark:text-white">${safeText(p.name || 'Agente')}</div>`).join('') : `<div class="text-gray-500 dark:text-gray-400 bg-white/70 dark:bg-gray-800/70 px-6 py-3 rounded shadow">Esperando agentes reales...</div>`}
                                       </div>`;
                btnNext.innerText = "Empezar Dinámica"; statusLabel.innerText = "Esperando jugadores...";
            } 
            else if (upanahootExecState.status === 'question') {
                const q = upanahootExecState.upanahoot.questions[upanahootExecState.qIdx];
                const colors = ['bg-[#e21b3c]', 'bg-[#1368ce]', 'bg-[#d89e00]', 'bg-[#26890c]'];
                const shapes = ['fa-play -rotate-90', 'fa-gem', 'fa-circle', 'fa-square'];
                const remaining = getUPANAHOOTRemainingSeconds(upanahootExecState);
                container.innerHTML = `
                    <div class="w-24 h-24 rounded-full bg-[#46178f] text-white flex items-center justify-center text-4xl font-black shadow-2xl mb-6">${remaining}</div>
                    <div class="bg-white text-black p-8 rounded shadow text-center w-full max-w-4xl mb-8">
                        <h2 class="text-4xl font-bold">${safeText(q.q || '')}</h2>
                        ${q.imageUrl ? `<img src="${safeText(q.imageUrl)}" class="mt-5 max-h-72 max-w-full object-contain rounded-xl mx-auto">` : ''}
                    </div>
                    <div class="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-4">
                        ${[0,1,2,3].map(i => `
                            <div class="${colors[i]} upanahoot-answer-card min-h-28 rounded flex items-center p-6 shadow-md shadow-black/20 text-white">
                                <i class="fa-solid ${shapes[i]} text-4xl mr-6 opacity-80 shrink-0"></i>
                                <span class="text-2xl md:text-3xl font-bold leading-tight">${safeText(q.options?.[i] || '')}</span>
                            </div>
                        `).join('')}
                    </div>
                `;
                btnNext.innerText = "Mostrar Resultados"; statusLabel.innerText = `Pregunta ${upanahootExecState.qIdx + 1} de ${upanahootExecState.upanahoot.questions.length} • Tiempo: ${remaining}s`;
                scheduleUPANAHOOTTimer();
            }
            else if (upanahootExecState.status === 'results') {
                const q = upanahootExecState.upanahoot.questions[upanahootExecState.qIdx];
                const colors = ['#e21b3c', '#1368ce', '#d89e00', '#26890c'];
                const responses = Object.values(upanahootExecState.responses?.[upanahootExecState.qIdx] || {});
                const participants = getSessionParticipants(upanahootExecState);
                const counts = [0, 0, 0, 0];
                responses.forEach(r => { if(Number.isInteger(Number(r.answerIndex))) counts[Number(r.answerIndex)] = (counts[Number(r.answerIndex)] || 0) + 1; });
                const maxCount = Math.max(1, ...counts);
                const correctCount = responses.filter(r => r.isCorrect).length;
                container.innerHTML = `
                    <h2 class="text-4xl font-bold text-gray-800 dark:text-white mb-2">Resultados de la pregunta</h2>
                    <p class="text-gray-500 dark:text-gray-300 font-bold mb-8">${responses.length} de ${participants.length} respuestas · ${correctCount} correctas</p>
                    <div class="flex items-end h-72 gap-6 md:gap-8 mb-8">
                        ${[0,1,2,3].map(i => {
                            const isCorrect = (Number(q.correct) === i);
                            const height = `${Math.max(8, Math.round((counts[i] / maxCount) * 100))}%`;
                            return `<div class="flex flex-col items-center w-20 md:w-28 h-full justify-end">
                                <div class="font-bold text-gray-600 dark:text-gray-300 mb-2">${counts[i]} ${isCorrect ? '<i class="fa-solid fa-check text-success text-2xl ml-1"></i>' : ''}</div>
                                <div style="height: ${height}; background-color: ${colors[i]}" class="w-full rounded-t shadow-lg"></div>
                                <div class="mt-2 text-xs font-bold text-gray-500 dark:text-gray-400">${['A','B','C','D'][i]}</div>
                            </div>`;
                        }).join('')}
                    </div>
                    <div class="bg-white dark:bg-gray-800 rounded-xl p-4 w-full max-w-4xl shadow text-left">
                        <div class="text-xs uppercase tracking-widest font-black text-gray-500 mb-3">Detalle por agente</div>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                            ${participants.map(p => {
                                const r = upanahootExecState.responses?.[upanahootExecState.qIdx]?.[p.id];
                                return `<div class="flex justify-between gap-3 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm dark:text-white">
                                    <span class="font-bold truncate">${safeText(p.name || 'Agente')}</span>
                                    <span class="${r?.isCorrect ? 'text-success' : 'text-danger'} font-black">${r ? `${r.isCorrect ? 'Correcta' : 'Incorrecta'} · ${Number(r.points || 0)} pts` : 'Sin respuesta'}</span>
                                </div>`;
                            }).join('')}
                        </div>
                    </div>
                `;
                btnNext.innerText = upanahootExecState.qIdx + 1 >= upanahootExecState.upanahoot.questions.length ? "Ver Podio" : "Siguiente Pregunta";
                statusLabel.innerText = "Revisión de respuestas";
            }
            else if (upanahootExecState.status === 'podium') {
                const podium = buildUPANAHOOTPodium(upanahootExecState, upanahootExecState.upanahoot);
                container.innerHTML = `
                    <div class="text-center w-full max-w-5xl">
                        <h2 class="text-5xl font-black text-gray-800 dark:text-white mb-4">¡Podio Final!</h2>
                        <p class="text-gray-500 dark:text-gray-300 font-bold mb-10">Resultados guardados para evaluación de admin y trainer.</p>
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 items-end mb-8">
                            ${podium.slice(0, 3).map((p, idx) => `
                                <div class="rounded-xl p-6 shadow-2xl text-center text-gray-950 ${idx === 0 ? 'bg-[#ffd700] md:order-2 md:min-h-64' : idx === 1 ? 'bg-[#c0c0c0] md:order-1 md:min-h-52' : 'bg-[#cd7f32] md:order-3 md:min-h-44'}">
                                    <div class="text-5xl font-black mb-3">${idx + 1}</div>
                                    <div class="text-2xl font-black truncate">${safeText(p.name)}</div>
                                    <div class="text-3xl font-black mt-3">${p.score} pts</div>
                                </div>
                            `).join('') || `<div class="bg-white rounded-xl p-6 shadow-2xl md:col-span-3 font-black">Sin respuestas registradas</div>`}
                        </div>
                        <div class="bg-white dark:bg-gray-800 rounded-xl p-4 shadow text-left">
                            <div class="text-xs uppercase tracking-widest font-black text-gray-500 mb-3">Ranking completo</div>
                            ${podium.map((p, idx) => `<div class="flex justify-between border-b border-gray-200 dark:border-gray-700 py-2 dark:text-white"><span class="font-bold">${idx + 1}. ${safeText(p.name)}</span><span class="font-black text-warning">${p.score} pts</span></div>`).join('')}
                        </div>
                    </div>
                `;
                btnNext.innerText = "Finalizar"; statusLabel.innerText = "Dinámica concluida";
            }
        }
