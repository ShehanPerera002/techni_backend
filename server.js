const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// 1. Firebase Admin Setup — env-based for hosting, local file fallback
let firebaseCredential;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    firebaseCredential = admin.credential.cert(serviceAccount);
} else {
    const localPath = path.join(__dirname, 'service-account.json.json');
    if (fs.existsSync(localPath)) {
        const serviceAccount = require(localPath);
        firebaseCredential = admin.credential.cert(serviceAccount);
    } else {
        const fallback = path.join(__dirname, 'service-account.json');
        const serviceAccount = require(fallback);
        firebaseCredential = admin.credential.cert(serviceAccount);
    }
}
admin.initializeApp({ credential: firebaseCredential });
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint (required by hosting platforms)
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 🚀 Helper: Distance Calculation (Haversine Formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function normalizeCategoryKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function resolvePricingDocId(categoryName) {
    const key = normalizeCategoryKey(categoryName);
    const categoryMap = {
        plumbing_services: 'plumber',
        plumbing: 'plumber',
        plumber: 'plumber',
        ac_technician: 'ac_technician',
        ac_repair: 'ac_technician',
        electrical_services: 'electrician',
        electrical: 'electrician',
        electrician: 'electrician',
        carpentry: 'carpenter',
        carpenter: 'carpenter',
        painting: 'painter',
        painter: 'painter',
        gardening: 'gardener',
        gardener: 'gardener',
        elv_repairer: 'elv_repairer'
    };

    return categoryMap[key] || key;
}

function resolveWorkerCategoryKey(categoryName) {
    const key = normalizeCategoryKey(categoryName);
    const categoryMap = {
        plumbing_services: 'plumber',
        plumbing: 'plumber',
        plumber: 'plumber',
        electrical_services: 'electrician',
        electrical: 'electrician',
        electrician: 'electrician',
        gardening_services: 'gardener',
        gardening: 'gardener',
        gardener: 'gardener',
        carpentry_services: 'carpenter',
        carpentry: 'carpenter',
        carpenter: 'carpenter',
        painting_services: 'painter',
        painting: 'painter',
        painter: 'painter',
        ac_services: 'ac_tech',
        ac_technician: 'ac_tech',
        ac_repair: 'ac_tech',
        ac_tech: 'ac_tech',
        elv_services: 'elv_repair',
        elv_repairer: 'elv_repair',
        elv_repair: 'elv_repair'
    };
    return categoryMap[key] || key;
}

async function sendNewJobPush(jobId, serviceTitle, workerIds) {
    const uniqueWorkerIds = [...new Set(workerIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (uniqueWorkerIds.length === 0) {
        return { sentCount: 0, failedCount: 0, message: 'No valid worker IDs' };
    }

    const workerDocs = await Promise.all(
        uniqueWorkerIds.map((id) => db.collection('workers').doc(id).get())
    );

    const tokens = [];
    for (const doc of workerDocs) {
        if (!doc.exists) continue;
        const data = doc.data() || {};
        const token = (data.fcmToken || '').toString().trim();
        if (token && token !== 'dummy-token') {
            tokens.push(token);
        }
    }

    if (tokens.length === 0) {
        return {
            sentCount: 0,
            failedCount: 0,
            message: 'No valid FCM tokens found for target workers',
        };
    }

    const message = {
        tokens,
        notification: {
            title: 'New Job Request',
            body: `A new ${serviceTitle} request is available nearby.`,
        },
        data: {
            type: 'newJobRequest',
            jobId: String(jobId),
        },
        android: {
            priority: 'high',
        },
        apns: {
            payload: {
                aps: {
                    sound: 'default',
                },
            },
        },
    };

    const result = await admin.messaging().sendEachForMulticast(message);
    return { sentCount: result.successCount, failedCount: result.failureCount };
}

async function processDueScheduledJobs() {
    const nowMs = Date.now();
    // Use a single-field query to avoid requiring a composite Firestore index at startup.
    const pendingSnap = await db.collection('scheduledJobs')
        .where('status', '==', 'pending')
        .limit(100)
        .get();

    if (pendingSnap.empty) return;

    const dueDocs = pendingSnap.docs.filter((doc) => {
        const data = doc.data() || {};
        const scheduledAt = data.scheduledAt;
        if (!scheduledAt) return false;

        const scheduledMs =
            typeof scheduledAt?.toMillis === 'function'
                ? scheduledAt.toMillis()
                : new Date(scheduledAt).getTime();

        return Number.isFinite(scheduledMs) && scheduledMs <= nowMs;
    }).slice(0, 25);

    if (dueDocs.length === 0) return;

    for (const doc of dueDocs) {
        const data = doc.data() || {};
        const scheduledJobId = doc.id;
        const categoryKey = resolveWorkerCategoryKey(data.category || data.serviceTitle || '');

        const workersSnap = await db.collection('workers')
            .where('isAvailable', '==', true)
            .get();

        const customerGeo = data.customerLocation;
        const matchedWorkers = workersSnap.docs
            .map((w) => ({ id: w.id, data: w.data() || {} }))
            .filter((w) => {
                const workerCategory = resolveWorkerCategoryKey(
                    w.data.category || w.data.category_name || w.data.serviceCategory || ''
                );
                const verification = String(w.data.verificationStatus || '').toLowerCase();
                return workerCategory === categoryKey && verification !== 'blocked';
            })
            .map((w) => {
                const lastLoc = w.data.lastLocation || w.data.location;
                let km = Number.MAX_SAFE_INTEGER;
                if (customerGeo && lastLoc &&
                    typeof customerGeo.latitude === 'number' &&
                    typeof customerGeo.longitude === 'number' &&
                    typeof lastLoc.latitude === 'number' &&
                    typeof lastLoc.longitude === 'number') {
                    km = calculateDistance(
                        customerGeo.latitude,
                        customerGeo.longitude,
                        lastLoc.latitude,
                        lastLoc.longitude
                    );
                }
                return { id: w.id, distanceKm: km };
            })
            .sort((a, b) => a.distanceKm - b.distanceKm)
            .slice(0, 10);

        const notifiedWorkerIds = matchedWorkers.map((w) => w.id);

        const jobRef = db.collection('jobRequests').doc(scheduledJobId);
        const batch = db.batch();

        batch.set(jobRef, {
            customerId: data.customerId || '',
            customerName: data.customerName || 'Customer',
            customerPhone: data.customerPhone || null,
            customerLocation: data.customerLocation || null,
            status: 'searching',
            jobType: data.serviceTitle || 'Service',
            description: data.description || null,
            issueImageUrl: data.issueImageUrl || null,
            notifiedWorkerIds,
            rejectedWorkerIds: [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            customerRef: data.customerId ? db.collection('customers').doc(data.customerId) : null,
            fromScheduledJobId: scheduledJobId,
            scheduledAtOriginal: data.scheduledAt || null,
        }, { merge: true });

        batch.set(db.collection('scheduledJobs').doc(scheduledJobId), {
            status: 'released',
            releasedAt: admin.firestore.FieldValue.serverTimestamp(),
            releasedJobId: scheduledJobId,
        }, { merge: true });

        for (const wid of notifiedWorkerIds) {
            const notifRef = db.collection('notifications').doc();
            batch.set(notifRef, {
                recipientId: wid,
                recipientRole: 'worker',
                type: 'newJobRequest',
                jobRequestId: scheduledJobId,
                title: 'New Job Request',
                message: `A new ${data.serviceTitle || 'Service'} request is available nearby.`,
                isRead: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }

        await batch.commit();
        if (notifiedWorkerIds.length > 0) {
            const pushResult = await sendNewJobPush(
                scheduledJobId,
                data.serviceTitle || 'Service',
                notifiedWorkerIds
            );
            console.log(`[SCHEDULED_RELEASE] ${scheduledJobId} -> jobRequests. workers=${notifiedWorkerIds.length}, sent=${pushResult.sentCount}, failed=${pushResult.failedCount}`);
        } else {
            console.log(`[SCHEDULED_RELEASE] ${scheduledJobId} released, but no matching workers were found.`);
        }
    }
}

async function resolvePerKmCharge(pricingData) {
    const nested = parseFloat(pricingData?.travel_settings?.per_km_charge);
    if (!Number.isNaN(nested) && nested >= 0) return nested;

    const direct = parseFloat(pricingData?.per_km_charge);
    if (!Number.isNaN(direct) && direct >= 0) return direct;

    // Fallback: global document pricing_logic/travel_settings { per_km_charge: ... }
    const globalSnap = await db.collection('pricing_logic').doc('travel_settings').get();
    if (!globalSnap.exists) return 0;

    const globalData = globalSnap.data() || {};
    const global = parseFloat(globalData.per_km_charge);
    return Number.isNaN(global) || global < 0 ? 0 : global;
}
// 👷 1. Create Worker Profile — Backend-Controlled Initialization
app.post('/api/worker/create-profile', async (req, res) => {
    try {
        const {
            uid, name, nic, phoneNumber, dob, languages, category,
            latitude, longitude, profileUrl, nicFrontUrl, nicBackUrl,
            policeReportUrl, certificates
        } = req.body;

        if (!uid || !name) {
            return res.status(400).json({ error: "uid and name are required" });
        }

        const workerRef = db.collection('workers').doc(uid);
        const workerDoc = await workerRef.get();

        // Security: Don't overwrite if already exists
        if (workerDoc.exists) {
            return res.status(409).json({ error: "Worker profile already exists" });
        }

        // ✅ SECURE: Backend controls ONLY these critical sensitive fields
        const profileData = {
            uid,
            name,
            nic,
            phoneNumber,
            dob,
            languages: languages || [],
            category,
            location: new admin.firestore.GeoPoint(latitude, longitude),
            profileUrl,
            nicFrontUrl,
            nicBackUrl,
            policeReportUrl,
            certificates: certificates || [],
            verificationStatus: 'pending',    // ✅ Backend-controlled (SENSITIVE)
            walletBalance: 0,                 // ✅ Backend-controlled (SENSITIVE)
            earnings: 0,                      // ✅ Backend-controlled: incremented on each job completion
            isOnline: false,                  // Initialize offline, location service sets to true
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // Use transaction for atomicity
        await db.runTransaction(async (transaction) => {
            // 1. Create worker profile
            transaction.set(workerRef, profileData);

            // 2. Create welcome review in sub-collection
            const reviewRef = workerRef.collection('reviews').doc();
            transaction.set(reviewRef, {
                reviewerName: 'System',
                rating: 5,
                comment: 'Welcome to the platform! Your profile is pending verification.',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        console.log(`[PROFILE] Worker ${uid} created with walletBalance=0, earnings=0, verificationStatus=pending`);

        res.json({
            success: true,
            message: "Profile created successfully",
            worker: {
                uid,
                name,
                verificationStatus: 'pending',
                walletBalance: 0,
                earnings: 0,
                isOnline: false
            }
        });
    } catch (e) {
        console.error(`[PROFILE] Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});
// � 2. Start Job API (legacy endpoint kept for compatibility)
app.post('/api/worker/start-job', async (req, res) => {
    try {
        const { jobId } = req.body;
        await db.collection('jobRequests').doc(jobId).update({
            status: 'workStarted',
            jobStartedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true, message: "Job Started!" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/job/confirm-start', async (req, res) => {
    try {
        const { jobId } = req.body;
        if (!jobId) return res.status(400).json({ error: "jobId is required" });
        await db.collection('jobRequests').doc(jobId).update({
            status: 'workStarted',
            jobStartedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true, message: "Job started!" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 💰 3. Complete Job & Pricing + Wallet Logic API
app.post('/api/worker/complete-job', async (req, res) => {
    try {
        const { jobId, category_name, workerId: requestWorkerId, distanceKm: requestDistanceKm } = req.body;
        if (!jobId || !category_name) {
            return res.status(400).json({ error: "jobId and category_name are required" });
        }

        // Fetch the job
        const jobRef = db.collection('jobRequests').doc(jobId);
        const jobDoc = await jobRef.get();
        if (!jobDoc.exists) return res.status(404).json({ error: "Job not found" });
        const jobData = jobDoc.data();
        const workerId = (jobData.workerId || requestWorkerId || '').toString().trim();
        if (!workerId) {
            return res.status(400).json({ error: "workerId is missing on both job and request" });
        }

        // Time calculation
        const startTime = jobData.jobStartedAt.toDate();
        const endTime = new Date();
        const durationSeconds = Math.floor((endTime - startTime) / 1000);
        const currentHour = endTime.getHours();

        const pricingDocId = resolvePricingDocId(category_name);

        // Fetch pricing logic
        const pSnap = await db.collection('pricing_logic').doc(pricingDocId).get();
        if (!pSnap.exists) return res.status(404).json({ error: `No pricing found for category: ${pricingDocId}` });
        const p = pSnap.data();

        // Determine rate by time of day
        let selectedRate = p.day_rate;
        let rateType = "Day Rate";
        if (currentHour >= 0 && currentHour < 6) {
            selectedRate = p.emergency_rate;
            rateType = "Emergency Rate";
        } else if (currentHour >= 18) {
            selectedRate = p.night_rate;
            rateType = "Night Rate";
        }

        // Distance Calculation
        let distanceKm = 0;
        let travelCost = 0;

        const requestDistance = parseFloat(requestDistanceKm);
        const estimatedDistance = parseFloat(jobData.distanceKmEstimate);

        if (!Number.isNaN(requestDistance) && requestDistance > 0) {
            distanceKm = requestDistance;
        } else if (!Number.isNaN(estimatedDistance) && estimatedDistance > 0) {
            distanceKm = estimatedDistance;
        } else if (jobData.customerLocation && jobData.workerLocation) {
            distanceKm = calculateDistance(
                jobData.customerLocation.latitude, jobData.customerLocation.longitude,
                jobData.workerLocation.latitude, jobData.workerLocation.longitude
            );
        }

        const perKmCharge = await resolvePerKmCharge(p);
        travelCost = distanceKm * perKmCharge;

        // Fare calculation (service_fee is app fee; do not add to worker/customer fare)
        const durationHours = durationSeconds / 3600;
        const timeCharge = durationHours * selectedRate;
        const totalFare = Math.round(p.base_fare + timeCharge + travelCost);
        if (!Number.isFinite(totalFare)) {
            return res.status(500).json({ error: "Calculated fare is invalid" });
        }

        // Worker wallet: deduct service_fee only (not the full fare)
        const workerRef = db.collection('workers').doc(workerId);
        const workerDoc = await workerRef.get();
        let currentBalance = 0;

        if (workerDoc.exists) {
            const workerData = workerDoc.data();
            currentBalance = workerData.walletBalance ?? 0;
        }

        const newBalance = currentBalance - p.service_fee;
        const newVerificationStatus = newBalance < -2000 ? 'blocked' : 'verified';

        await workerRef.set({
            walletBalance: newBalance,
            verificationStatus: newVerificationStatus
        }, { merge: true });

        // Move to 'completed jobs' (with space — matches Flutter streamCompletedJobs query)
        const completedData = {
            ...jobData,
            status: 'completed',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            durationSeconds,
            distanceKm: distanceKm.toFixed(2),
            fare: totalFare,
            workerEarnings: totalFare,
            serviceFee: p.service_fee,
            rateType
        };
        await db.collection('completed jobs').doc(jobId).set(completedData);
        await jobRef.delete();

        // ✅ Increment worker earnings by workerEarnings (the actual worker payout)
        await workerRef.set({
            earnings: admin.firestore.FieldValue.increment(totalFare),
            activeJobId: null,
        }, { merge: true });
        console.log(`[COMPLETE] Worker ${workerId} earnings incremented by ${totalFare}`);

        const updatedWorkerDoc = await workerRef.get();
        const updatedWorkerData = updatedWorkerDoc.exists ? (updatedWorkerDoc.data() || {}) : {};
        const totalEarnings = parseFloat(updatedWorkerData.earnings) || 0;

        res.json({
            success: true,
            fare: totalFare,
            workerEarnings: totalFare,
            serviceFee: p.service_fee,
            duration: durationSeconds,
            rateType,
            walletBalance: newBalance,
            totalEarnings,
            workerBlocked: newVerificationStatus === 'blocked'
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 💳 Pay Outstanding Dues — adds amount to wallet and unblocks worker
app.post('/api/worker/pay-dues', async (req, res) => {
    try {
        const { workerId, amount } = req.body;
        if (!workerId) {
            return res.status(400).json({ error: "workerId is required" });
        }

        if (amount === undefined || amount === null || amount === '') {
            return res.status(400).json({ error: "amount is required" });
        }

        const amountToAdd = parseFloat(amount);
        if (isNaN(amountToAdd) || amountToAdd <= 0) {
            return res.status(400).json({ error: "amount must be a valid positive number" });
        }

        const workerRef = db.collection('workers').doc(workerId);
        const workerDoc = await workerRef.get();

        if (!workerDoc.exists) {
            return res.status(404).json({ error: "Worker not found" });
        }

        const currentBalance = parseFloat(workerDoc.data().walletBalance) || 0;
        const newBalance = currentBalance + amountToAdd;
        const newVerificationStatus = newBalance < -2000 ? 'blocked' : 'verified';

        await workerRef.set({
            walletBalance: newBalance,
            verificationStatus: newVerificationStatus
        }, { merge: true });

        res.json({
            success: true,
            message: newVerificationStatus === 'verified'
                ? "Outstanding dues paid. Account unblocked."
                : "Partial payment received. Additional dues required.",
            newBalance: newBalance,
            walletBalance: newBalance
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 💰 Top Up Wallet — adds funds to worker's wallet
app.post('/api/worker/topup', async (req, res) => {
    try {
        const { workerId, amount } = req.body;
        console.log(`[TOPUP] workerId: ${workerId}, amount: ${amount}, type: ${typeof amount}`);
        
        if (!workerId) {
            return res.status(400).json({ error: "workerId is required" });
        }
        if (amount === undefined || amount === null || amount === '') {
            return res.status(400).json({ error: "amount is required" });
        }

        const workerRef = db.collection('workers').doc(workerId);
        const workerDoc = await workerRef.get();

        if (!workerDoc.exists) {
            console.log(`[TOPUP] Worker not found: ${workerId}`);
            return res.status(404).json({ error: "Worker not found" });
        }

        const currentBalance = parseFloat(workerDoc.data().walletBalance) || 0;
        const amountToAdd = parseFloat(amount);
        
        if (isNaN(amountToAdd)) {
            return res.status(400).json({ error: "amount must be a valid number" });
        }
        
        const newBalance = currentBalance + amountToAdd;
        console.log(`[TOPUP] currentBalance: ${currentBalance}, adding: ${amountToAdd}, newBalance: ${newBalance}`);

        const newVerificationStatus = newBalance < -2000 ? 'blocked' : 'verified';

        await workerRef.update({
            walletBalance: newBalance,
            verificationStatus: newVerificationStatus
        });

        console.log(`[TOPUP] Successfully updated worker ${workerId} with new balance: ${newBalance}`);
        
        res.json({
            success: true,
            message: "Wallet topped up successfully.",
            newBalance: newBalance,
            amountAdded: amountToAdd,
            walletBalance: newBalance
        });
    } catch (e) { 
        console.error(`[TOPUP] Error:`, e.message);
        res.status(500).json({ error: e.message }); 
    }
});

// 🔁 Sync Verification Status from Wallet Balance
app.post('/api/worker/sync-verification-status', async (req, res) => {
    try {
        const { workerId } = req.body;
        if (!workerId) {
            return res.status(400).json({ error: 'workerId is required' });
        }

        const workerRef = db.collection('workers').doc(workerId);
        const workerDoc = await workerRef.get();

        if (!workerDoc.exists) {
            return res.status(404).json({ error: 'Worker not found' });
        }

        const data = workerDoc.data() || {};
        const walletBalance = parseFloat(data.walletBalance) || 0;
        const expectedStatus = walletBalance < -2000 ? 'blocked' : 'verified';
        const currentStatus = (data.verificationStatus || '').toString().trim().toLowerCase();

        if (currentStatus !== expectedStatus) {
            await workerRef.set({ verificationStatus: expectedStatus }, { merge: true });
        }

        return res.json({
            success: true,
            walletBalance,
            verificationStatus: expectedStatus,
            updated: currentStatus !== expectedStatus,
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// 📝 Update Worker Bio — Worker updates their bio/about section
app.post('/api/worker/update-bio', async (req, res) => {
    try {
        const { workerId, bio } = req.body;
        if (!workerId || bio === undefined) {
            return res.status(400).json({ error: "workerId and bio are required" });
        }

        // Max 500 characters
        if (bio.length > 500) {
            return res.status(400).json({ error: "Bio must be 500 characters or less" });
        }

        const workerRef = db.collection('workers').doc(workerId);
        const workerDoc = await workerRef.get();

        if (!workerDoc.exists) {
            return res.status(404).json({ error: "Worker not found" });
        }

        await workerRef.update({
            bio: bio.trim()
        });

        console.log(`[BIO] Worker ${workerId} bio updated`);
        
        res.json({
            success: true,
            message: "Bio updated successfully",
            bio: bio.trim()
        });
    } catch (e) { 
        console.error(`[BIO] Error: ${e.message}`);
        res.status(500).json({ error: e.message }); 
    }
});

// ⭐ Submit customer review for completed job
app.post('/api/job/submit-review', async (req, res) => {
    try {
        const {
            jobId,
            workerId,
            rating,
            comment,
            reviewerName,
            reviewerId,
        } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required' });
        }

        const parsedRating = parseInt(rating, 10);
        if (Number.isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
            return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
        }

        const completedRef = db.collection('completed jobs').doc(jobId);
        const completedDoc = await completedRef.get();
        if (!completedDoc.exists) {
            return res.status(404).json({ error: 'Completed job not found' });
        }

        const completedData = completedDoc.data() || {};
        const targetWorkerId = workerId || completedData.workerId;
        if (!targetWorkerId) {
            return res.status(400).json({ error: 'workerId is required or must exist in completed job' });
        }

        const workerRef = db.collection('workers').doc(targetWorkerId);
        const reviewRef = workerRef.collection('reviews').doc(jobId);

        await db.runTransaction(async (transaction) => {
            const workerDoc = await transaction.get(workerRef);
            if (!workerDoc.exists) {
                throw new Error('Worker not found');
            }

            const existingReview = await transaction.get(reviewRef);
            if (existingReview.exists) {
                throw new Error('Review already submitted for this job');
            }

            const workerData = workerDoc.data() || {};
            const currentAverage = parseFloat(workerData.averageRating) || 0;
            const currentCount = parseInt(workerData.ratingCount, 10) || 0;
            const newCount = currentCount + 1;
            const newAverage = ((currentAverage * currentCount) + parsedRating) / newCount;

            transaction.set(reviewRef, {
                jobId,
                reviewerId: reviewerId || completedData.customerId || null,
                reviewerName: reviewerName || completedData.customerName || 'Customer',
                rating: parsedRating,
                comment: (comment || '').toString().trim(),
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });

            transaction.set(completedRef, {
                rating: parsedRating,
                review: (comment || '').toString().trim(),
                feedbackAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });

            transaction.set(workerRef, {
                averageRating: parseFloat(newAverage.toFixed(2)),
                ratingCount: newCount,
                isAvailable: true,
                activeJobId: null,
            }, { merge: true });
        });

        return res.json({
            success: true,
            message: 'Review submitted successfully',
            workerId: targetWorkerId,
        });
    } catch (e) {
        if (e.message === 'Review already submitted for this job') {
            return res.status(409).json({ error: e.message });
        }
        if (e.message === 'Worker not found') {
            return res.status(404).json({ error: e.message });
        }
        return res.status(500).json({ error: e.message });
    }
});

// ⏱️ Get Elapsed Time — Both apps sync timers from backend
app.get('/api/job/:jobId/elapsed-time', async (req, res) => {
    try {
        const { jobId } = req.params;
        if (!jobId) {
            return res.status(400).json({ error: "jobId is required" });
        }

        // Try jobRequests first (active jobs)
        const jobRef = db.collection('jobRequests').doc(jobId);
        const jobDoc = await jobRef.get();
        
        if (!jobDoc.exists) {
            // Try completed jobs
            const completedRef = db.collection('completed jobs').doc(jobId);
            const completedDoc = await completedRef.get();
            if (!completedDoc.exists) {
                return res.status(404).json({ error: "Job not found" });
            }
            const jobData = completedDoc.data();
            // Return stored duration for completed jobs
            return res.json({
                success: true,
                elapsedSeconds: jobData.durationSeconds || 0,
                status: 'completed'
            });
        }

        const jobData = jobDoc.data();
        const status = jobData.status;

        // If job hasn't started yet
        if (status === 'searching' || status === 'inProgress' || status === 'arrived') {
            return res.json({
                success: true,
                elapsedSeconds: 0,
                status: status
            });
        }

        // Calculate elapsed time from jobStartedAt
        if (!jobData.jobStartedAt) {
            return res.json({
                success: true,
                elapsedSeconds: 0,
                status: status
            });
        }

        const startTime = jobData.jobStartedAt.toDate();
        const currentTime = new Date();
        const elapsedSeconds = Math.floor((currentTime - startTime) / 1000);

        res.json({
            success: true,
            elapsedSeconds: Math.max(0, elapsedSeconds),
            status: status,
            jobStartedAt: jobData.jobStartedAt.toDate().toISOString()
        });
    } catch (e) {
        console.error(`[ELAPSED_TIME] Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// 💰 Calculate Price — Preview calculation before job completion
app.post('/api/job/calculate-price', async (req, res) => {
    try {
        const { 
            category_name, 
            durationSeconds, 
            jobId,
            customerLocation,
            workerLocation,
            distanceKm: requestDistanceKm
        } = req.body;

        if (!category_name || !durationSeconds) {
            return res.status(400).json({ error: "category_name and durationSeconds are required" });
        }

        const pricingDocId = resolvePricingDocId(category_name);

        // Fetch pricing logic
        const pSnap = await db.collection('pricing_logic').doc(pricingDocId).get();
        if (!pSnap.exists) {
            return res.status(404).json({ error: `No pricing found for category: ${pricingDocId}` });
        }
        const p = pSnap.data();

        // Determine rate by time of day (for now, use current time; can accept 'completedAt' timestamp)
        const completedAt = new Date();
        const currentHour = completedAt.getHours();
        let selectedRate = p.day_rate;
        let rateType = "Day Rate";
        
        if (currentHour >= 0 && currentHour < 6) {
            selectedRate = p.emergency_rate;
            rateType = "Emergency Rate";
        } else if (currentHour >= 18) {
            selectedRate = p.night_rate;
            rateType = "Night Rate";
        }

        // Distance Calculation (prefer provided km when available)
        let distanceKm = 0;
        let travelCost = 0;
        const requestDistance = parseFloat(requestDistanceKm);

        if (!Number.isNaN(requestDistance) && requestDistance > 0) {
            distanceKm = requestDistance;
        } else if (customerLocation && workerLocation && 
            customerLocation.latitude && customerLocation.longitude &&
            workerLocation.latitude && workerLocation.longitude) {
            distanceKm = calculateDistance(
                customerLocation.latitude, customerLocation.longitude,
                workerLocation.latitude, workerLocation.longitude
            );
        }

        const perKmCharge = await resolvePerKmCharge(p);
        travelCost = distanceKm * perKmCharge;

        // Fare calculation (service_fee is app fee; deducted from wallet, not added to fare)
        const durationHours = durationSeconds / 3600;
        const timeCharge = durationHours * selectedRate;
        const totalFare = Math.round(p.base_fare + timeCharge + travelCost);

        res.json({
            success: true,
            fare: totalFare,
            breakdown: {
                baseFare: p.base_fare,
                serviceFee: p.service_fee,
                timeCharge: Math.round(timeCharge),
                travelCost: Math.round(travelCost),
                workerEarnings: totalFare,
                totalFare: totalFare
            },
            rateType,
            duration: durationSeconds,
            distance: parseFloat(distanceKm.toFixed(2))
        });
    } catch (e) {
        console.error(`[CALCULATE_PRICE] Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ai-chat', (req, res) => {
    const { message } = req.body;
    res.json({ reply: `Techni AI: Helping with "${message}". How can I assist you?` });
});

// 🔔 Send push notifications for a new job request
app.post('/api/notifications/new-job-request', async (req, res) => {
    try {
        const { jobId, serviceTitle, workerIds } = req.body;

        if (!jobId || !serviceTitle || !Array.isArray(workerIds) || workerIds.length === 0) {
            return res.status(400).json({ error: 'jobId, serviceTitle and workerIds are required' });
        }

        const result = await sendNewJobPush(jobId, serviceTitle, workerIds);
        console.log(`[NOTIFY] New job push sent. success=${result.sentCount}, failed=${result.failedCount}, jobId=${jobId}`);

        return res.json({
            success: true,
            sentCount: result.sentCount,
            failedCount: result.failedCount,
        });
    } catch (e) {
        console.error(`[NOTIFY] Error sending new job push: ${e.message}`);
        return res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 5000;

// Background scheduler: clean up stale searching jobs (no acceptance after 30 min).
setInterval(() => {
    cleanupStaleSearchingJobs().catch((e) => {
        console.error(`[CLEANUP] Error: ${e.message}`);
    });
}, 5 * 60 * 1000); // Every 5 minutes

// Background scheduler: release due scheduled jobs into normal jobRequests flow.
setInterval(() => {
    processDueScheduledJobs().catch((e) => {
        console.error(`[SCHEDULED_RELEASE] Error: ${e.message}`);
    });
}, 30000);

processDueScheduledJobs().catch((e) => {
    console.error(`[SCHEDULED_RELEASE] Startup run error: ${e.message}`);
});

// Auto-cancel searching jobs if no worker accepts them within 30 minutes (timeout window).
async function cleanupStaleSearchingJobs() {
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    const staleSnap = await db.collection('jobRequests')
        .where('status', '==', 'searching')
        .limit(50)
        .get();

    if (staleSnap.empty) return;

    for (const doc of staleSnap.docs) {
        const data = doc.data() || {};
        const createdTs = data.createdAt;
        const createdMs = createdTs?.toMillis ? createdTs.toMillis() : new Date(createdTs).getTime();

        if (Number.isFinite(createdMs) && createdMs < thirtyMinutesAgo) {
            // Job has been searching for >30 minutes, auto-cancel it
            await db.collection('jobRequests').doc(doc.id).update({
                status: 'cancelled',
                cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                cancelReason: 'No workers available (timeout)',
            });

            const fromScheduledId = data.fromScheduledJobId;
            if (fromScheduledId) {
                // Also cancel the source scheduled job
                await db.collection('scheduledJobs').doc(fromScheduledId).update({
                    status: 'noWorkersFound',
                    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            }

            console.log(`[CLEANUP] Job ${doc.id} auto-cancelled after 30+ minutes with no acceptance.`);
        }
    }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));