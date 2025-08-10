const admin = require('firebase-admin');
const functions = require('firebase-functions');

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

// CORS middleware
const corsHandler = (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
    
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return true;
    }
    return false;
};

// Helper function to verify user authentication
async function verifyUser(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new Error('Unauthorized');
    }
    
    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        return decodedToken.uid;
    } catch (error) {
        throw new Error('Invalid token');
    }
}

// Helper function to calculate match score
function calculateMatchScore(demobProfile, position) {
    let score = 0;
    let factors = {
        technical_skills: 0.4,
        project_type: 0.25,
        geographic: 0.2,
        timing: 0.15
    };
    
    // Technical skills matching
    const requiredSkills = position.required_skills || [];
    const candidateSkills = demobProfile.skill_inventory?.technical_skills || [];
    const skillMatch = requiredSkills.filter(skill => 
        candidateSkills.some(cs => cs.toLowerCase().includes(skill.toLowerCase()))
    ).length / (requiredSkills.length || 1);
    score += skillMatch * factors.technical_skills * 100;
    
    // Project type experience
    if (position.project_type && demobProfile.current_project?.name) {
        const typeMatch = position.project_type.toLowerCase().includes(demobProfile.current_project.name.toLowerCase()) ||
                         demobProfile.current_project.name.toLowerCase().includes(position.project_type.toLowerCase());
        score += (typeMatch ? 1 : 0.5) * factors.project_type * 100;
    }
    
    // Geographic compatibility
    const preferredLocations = demobProfile.mobility_preferences?.preferred_locations || [];
    const positionLocation = position.location || '';
    const geoMatch = preferredLocations.some(loc => 
        loc.toLowerCase().includes(positionLocation.toLowerCase()) ||
        positionLocation.toLowerCase().includes(loc.toLowerCase())
    );
    score += (geoMatch ? 1 : (demobProfile.mobility_preferences?.willing_to_relocate ? 0.7 : 0.3)) * factors.geographic * 100;
    
    // Timing alignment
    const demobDate = new Date(demobProfile.demob_date);
    const positionStartDate = new Date(position.start_date || Date.now());
    const daysDiff = Math.abs(demobDate - positionStartDate) / (1000 * 60 * 60 * 24);
    const timingScore = daysDiff <= 30 ? 1 : (daysDiff <= 90 ? 0.8 : 0.5);
    score += timingScore * factors.timing * 100;
    
    return Math.round(score);
}

// Helper function to match a profile to positions
async function matchProfileToPositions(demobProfile, projectId, minScore) {
    const matches = [];
    
    // Get all users
    const usersSnapshot = await db.collection('users').get();
    
    for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        
        // Get projects for this user
        let projectsQuery = db.collection(`users/${userId}/projects`);
        if (projectId) {
            const projectDoc = await projectsQuery.doc(projectId).get();
            if (projectDoc.exists) {
                await processProject(userDoc.id, projectDoc, demobProfile, minScore, matches);
            }
        } else {
            const projectsSnapshot = await projectsQuery.get();
            for (const projectDoc of projectsSnapshot.docs) {
                await processProject(userDoc.id, projectDoc, demobProfile, minScore, matches);
            }
        }
    }
    
    return matches;
}

async function processProject(userId, projectDoc, demobProfile, minScore, matches) {
    const project = projectDoc.data();
    
    // Get positions for this project
    const positionsSnapshot = await db.collection(`users/${userId}/projects/${projectDoc.id}/positions`)
        .where('status', '==', 'open')
        .get();
        
    for (const posDoc of positionsSnapshot.docs) {
        const position = posDoc.data();
        const matchScore = calculateMatchScore(demobProfile, position);
        
        if (matchScore >= minScore) {
            matches.push({
                employee_id: demobProfile.employee_id,
                employee_name: demobProfile.current_project?.role || 'Unknown',
                project_id: projectDoc.id,
                project_name: project.projectName,
                position_id: posDoc.id,
                position_title: position.title,
                match_score: matchScore,
                match_factors: {
                    skills_alignment: matchScore * 0.4,
                    project_experience: matchScore * 0.25,
                    geographic_fit: matchScore * 0.2,
                    timing_alignment: matchScore * 0.15
                },
                demob_date: demobProfile.demob_date,
                position_start_date: position.start_date,
                created_at: admin.firestore.FieldValue.serverTimestamp()
            });
        }
    }
}

// Helper function to save match record
async function saveMatchRecord(match) {
    const matchRef = db.collection('demob_matches').doc();
    await matchRef.set({
        ...match,
        status: 'Pending Review',
        notifications_sent: false
    });
    
    // Update demob profile with match history
    const demobRef = db.collection('demob_profiles').doc(match.employee_id);
    await demobRef.update({
        matching_history: admin.firestore.FieldValue.arrayUnion({
            opportunity: `${match.project_name} - ${match.position_title}`,
            match_score: match.match_score,
            status: 'Pending Review',
            date: new Date().toISOString()
        })
    });
}

// Helper function to trigger matching for a specific employee
async function triggerMatching(employeeId) {
    const demobDoc = await db.collection('demob_profiles').doc(employeeId).get();
    if (!demobDoc.exists) return;
    
    const demobProfile = demobDoc.data();
    const matches = await matchProfileToPositions(demobProfile, null, 70);
    
    // Save high-scoring matches
    const highMatches = matches.filter(m => m.match_score >= 75);
    for (const match of highMatches) {
        await saveMatchRecord(match);
    }
    
    return matches;
}

// 1. Create/Update Demob Profile
exports.createDemobProfile = functions.https.onRequest(async (req, res) => {
    // Handle CORS
    if (corsHandler(req, res)) return;
    
    try {
        const userId = await verifyUser(req);
        const { demobProfile } = req.body;
        
        if (!demobProfile || !demobProfile.employee_id) {
            return res.status(400).json({ error: 'Invalid demob profile data' });
        }
        
        // Validate required fields
        const requiredFields = ['employee_id', 'demob_date', 'current_project'];
        for (const field of requiredFields) {
            if (!demobProfile[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        // Add metadata
        demobProfile.last_updated = admin.firestore.FieldValue.serverTimestamp();
        demobProfile.created_by = userId;
        
        // Calculate retention priority if not provided
        if (!demobProfile.internal_metrics?.retention_priority) {
            const rating = demobProfile.internal_metrics?.performance_rating || 3;
            const yearsWithCompany = demobProfile.internal_metrics?.years_with_company || 1;
            const hasRareSkills = (demobProfile.skill_inventory?.technical_skills || []).some(skill =>
                ['AI', 'ML', 'Blockchain', 'Quantum'].some(rare => skill.includes(rare))
            );
            
            if (rating >= 4.5 || yearsWithCompany >= 5 || hasRareSkills) {
                demobProfile.internal_metrics = {
                    ...demobProfile.internal_metrics,
                    retention_priority: 'Critical'
                };
            } else if (rating >= 3.5 || yearsWithCompany >= 3) {
                demobProfile.internal_metrics = {
                    ...demobProfile.internal_metrics,
                    retention_priority: 'Standard'
                };
            } else {
                demobProfile.internal_metrics = {
                    ...demobProfile.internal_metrics,
                    retention_priority: 'External Option'
                };
            }
        }
        
        // Save to Firestore
        const docRef = db.collection('demob_profiles').doc(demobProfile.employee_id);
        await docRef.set(demobProfile, { merge: true });
        
        // Trigger matching for this profile
        await triggerMatching(demobProfile.employee_id);
        
        res.json({ 
            success: true, 
            employee_id: demobProfile.employee_id,
            message: 'Demob profile created/updated successfully' 
        });
        
    } catch (error) {
        console.error('Error creating demob profile:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. Get Demob Profiles with Filtering
exports.getDemobProfiles = functions.https.onRequest(async (req, res) => {
    // Handle CORS
    if (corsHandler(req, res)) return;
    
    try {
        const userId = await verifyUser(req);
        const { 
            retention_priority, 
            demob_date_start, 
            demob_date_end,
            location,
            skills,
            project,
            limit = 50,
            offset = 0
        } = req.query;
        
        let query = db.collection('demob_profiles');
        
        // Apply filters
        if (retention_priority) {
            query = query.where('internal_metrics.retention_priority', '==', retention_priority);
        }
        
        if (demob_date_start) {
            query = query.where('demob_date', '>=', demob_date_start);
        }
        
        if (demob_date_end) {
            query = query.where('demob_date', '<=', demob_date_end);
        }
        
        // Get all profiles for client-side filtering (skills, location, project)
        const snapshot = await query.limit(500).get();
        let profiles = [];
        
        snapshot.forEach(doc => {
            const data = doc.data();
            
            // Additional filtering
            let include = true;
            
            if (location && include) {
                const locations = data.mobility_preferences?.preferred_locations || [];
                include = locations.some(loc => loc.toLowerCase().includes(location.toLowerCase()));
            }
            
            if (skills && include) {
                const profileSkills = data.skill_inventory?.technical_skills || [];
                const requestedSkills = skills.split(',').map(s => s.trim().toLowerCase());
                include = requestedSkills.some(skill => 
                    profileSkills.some(ps => ps.toLowerCase().includes(skill))
                );
            }
            
            if (project && include) {
                include = data.current_project?.name?.toLowerCase().includes(project.toLowerCase());
            }
            
            if (include) {
                profiles.push({ id: doc.id, ...data });
            }
        });
        
        // Apply pagination
        const paginatedProfiles = profiles.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
        
        res.json({
            profiles: paginatedProfiles,
            total: profiles.length,
            offset: parseInt(offset),
            limit: parseInt(limit)
        });
        
    } catch (error) {
        console.error('Error getting demob profiles:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3. Match Demob Candidates to Positions
exports.matchDemobCandidates = functions.https.onRequest(async (req, res) => {
    // Handle CORS
    if (corsHandler(req, res)) return;
    
    try {
        const userId = await verifyUser(req);
        const { employee_id, project_id, min_score = 75 } = req.body;
        
        let matches = [];
        
        if (employee_id) {
            // Match specific employee to all positions
            const demobDoc = await db.collection('demob_profiles').doc(employee_id).get();
            if (!demobDoc.exists) {
                return res.status(404).json({ error: 'Demob profile not found' });
            }
            
            const demobProfile = demobDoc.data();
            matches = await matchProfileToPositions(demobProfile, project_id, min_score);
            
        } else if (project_id) {
            // Match all demob candidates to specific project positions
            const demobSnapshot = await db.collection('demob_profiles')
                .where('current_status', '==', 'Active - Demobilizing')
                .get();
                
            for (const doc of demobSnapshot.docs) {
                const demobProfile = doc.data();
                const profileMatches = await matchProfileToPositions(demobProfile, project_id, min_score);
                matches.push(...profileMatches);
            }
        } else {
            // Match all to all
            const demobSnapshot = await db.collection('demob_profiles')
                .where('current_status', '==', 'Active - Demobilizing')
                .get();
                
            for (const doc of demobSnapshot.docs) {
                const demobProfile = doc.data();
                const profileMatches = await matchProfileToPositions(demobProfile, null, min_score);
                matches.push(...profileMatches);
            }
        }
        
        // Sort by match score
        matches.sort((a, b) => b.match_score - a.match_score);
        
        // Save high-scoring matches
        const highMatches = matches.filter(m => m.match_score >= min_score);
        for (const match of highMatches) {
            await saveMatchRecord(match);
        }
        
        res.json({
            matches,
            high_probability_count: highMatches.length,
            total_evaluated: matches.length
        });
        
    } catch (error) {
        console.error('Error matching demob candidates:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. Get Demob Analytics
exports.getDemobAnalytics = functions.https.onRequest(async (req, res) => {
    // Handle CORS
    if (corsHandler(req, res)) return;
    
    try {
        const userId = await verifyUser(req);
        const { start_date, end_date, project_id } = req.query;
        
        // Build base query
        let demobQuery = db.collection('demob_profiles');
        let matchQuery = db.collection('demob_matches');
        
        if (start_date) {
            demobQuery = demobQuery.where('demob_date', '>=', start_date);
        }
        
        if (end_date) {
            demobQuery = demobQuery.where('demob_date', '<=', end_date);
        }
        
        if (project_id) {
            matchQuery = matchQuery.where('project_id', '==', project_id);
        }
        
        // Get data
        const [demobSnapshot, matchSnapshot] = await Promise.all([
            demobQuery.get(),
            matchQuery.get()
        ]);
        
        // Calculate metrics
        const totalDemob = demobSnapshot.size;
        const matches = matchSnapshot.docs.map(doc => doc.data());
        const successfulPlacements = matches.filter(m => m.status === 'Placed').length;
        const pendingReviews = matches.filter(m => m.status === 'Pending Review').length;
        
        // Skills gap analysis
        const skillsGap = {};
        const unplacedProfiles = [];
        
        demobSnapshot.forEach(doc => {
            const profile = doc.data();
            const hasMatch = matches.some(m => m.employee_id === profile.employee_id && m.status === 'Placed');
            
            if (!hasMatch) {
                unplacedProfiles.push(profile);
                // Track missing skills
                const skills = profile.skill_inventory?.technical_skills || [];
                skills.forEach(skill => {
                    skillsGap[skill] = (skillsGap[skill] || 0) + 1;
                });
            }
        });
        
        // Time to placement
        const placedMatches = matches.filter(m => m.status === 'Placed' && m.placement_date);
        const avgTimeToPlacement = placedMatches.length > 0
            ? placedMatches.reduce((sum, m) => {
                const demobDate = new Date(m.demob_date);
                const placementDate = new Date(m.placement_date);
                return sum + Math.abs(placementDate - demobDate) / (1000 * 60 * 60 * 24);
            }, 0) / placedMatches.length
            : 0;
        
        // Geographic mobility
        const mobilityStats = {
            willing_to_relocate: 0,
            preferred_same_region: 0,
            international_mobility: 0
        };
        
        demobSnapshot.forEach(doc => {
            const profile = doc.data();
            if (profile.mobility_preferences?.willing_to_relocate) {
                mobilityStats.willing_to_relocate++;
            }
            if (profile.mobility_preferences?.preferred_locations?.length > 1) {
                mobilityStats.international_mobility++;
            } else {
                mobilityStats.preferred_same_region++;
            }
        });
        
        // Priority distribution
        const priorityDistribution = {
            Critical: 0,
            Standard: 0,
            'External Option': 0
        };
        
        demobSnapshot.forEach(doc => {
            const profile = doc.data();
            const priority = profile.internal_metrics?.retention_priority || 'Standard';
            priorityDistribution[priority]++;
        });
        
        res.json({
            summary: {
                total_demobilizing: totalDemob,
                successful_placements: successfulPlacements,
                pending_reviews: pendingReviews,
                retention_rate: totalDemob > 0 ? (successfulPlacements / totalDemob * 100).toFixed(1) + '%' : '0%',
                avg_time_to_placement_days: Math.round(avgTimeToPlacement)
            },
            skills_gap_analysis: Object.entries(skillsGap)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([skill, count]) => ({ skill, unplaced_count: count })),
            mobility_statistics: mobilityStats,
            priority_distribution: priorityDistribution,
            pipeline_health: {
                high_probability_matches: matches.filter(m => m.match_score >= 85).length,
                medium_probability_matches: matches.filter(m => m.match_score >= 70 && m.match_score < 85).length,
                low_probability_matches: matches.filter(m => m.match_score < 70).length
            }
        });
        
    } catch (error) {
        console.error('Error getting demob analytics:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5. Bulk import demob profiles
exports.bulkImportDemobProfiles = functions.https.onRequest(async (req, res) => {
    // Handle CORS
    if (corsHandler(req, res)) return;
    
    try {
        const userId = await verifyUser(req);
        const { profiles } = req.body;
        
        if (!Array.isArray(profiles)) {
            return res.status(400).json({ error: 'Profiles must be an array' });
        }
        
        const batch = db.batch();
        const results = {
            imported: 0,
            failed: 0,
            errors: []
        };
        
        for (const profile of profiles) {
            try {
                // Validate profile
                if (!profile.employee_id) {
                    results.failed++;
                    results.errors.push({ employee_id: 'unknown', error: 'Missing employee_id' });
                    continue;
                }
                
                // Add metadata
                profile.last_updated = admin.firestore.FieldValue.serverTimestamp();
                profile.created_by = userId;
                profile.import_source = 'bulk_import';
                
                const docRef = db.collection('demob_profiles').doc(profile.employee_id);
                batch.set(docRef, profile, { merge: true });
                results.imported++;
                
            } catch (error) {
                results.failed++;
                results.errors.push({ 
                    employee_id: profile.employee_id || 'unknown', 
                    error: error.message 
                });
            }
        }
        
        await batch.commit();
        
        // Trigger matching for all imported profiles
        if (results.imported > 0) {
            console.log(`Bulk import completed: ${results.imported} profiles imported`);
            // Async trigger matching (don't wait)
            setTimeout(async () => {
                for (const profile of profiles) {
                    if (profile.employee_id) {
                        await triggerMatching(profile.employee_id);
                    }
                }
            }, 1000);
        }
        
        res.json(results);
        
    } catch (error) {
        console.error('Error in bulk import:', error);
        res.status(500).json({ error: error.message });
    }
});

// 6. Update match status
exports.updateMatchStatus = functions.https.onRequest(async (req, res) => {
    // Handle CORS
    if (corsHandler(req, res)) return;
    
    try {
        const userId = await verifyUser(req);
        const { match_id, status, notes, placement_date } = req.body;
        
        if (!match_id || !status) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const validStatuses = ['Pending Review', 'In Progress', 'Interview Scheduled', 'Placed', 'Rejected', 'Withdrawn'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        
        const updateData = {
            status,
            last_updated: admin.firestore.FieldValue.serverTimestamp(),
            updated_by: userId
        };
        
        if (notes) updateData.notes = notes;
        if (status === 'Placed' && placement_date) {
            updateData.placement_date = placement_date;
        }
        
        await db.collection('demob_matches').doc(match_id).update(updateData);
        
        res.json({ success: true, message: 'Match status updated' });
        
    } catch (error) {
        console.error('Error updating match status:', error);
        res.status(500).json({ error: error.message });
    }
});

// 7. Get role-based access permissions
exports.getUserPermissions = functions.https.onRequest(async (req, res) => {
    // Handle CORS
    if (corsHandler(req, res)) return;
    
    try {
        const userId = await verifyUser(req);
        
        // Get user document
        const userDoc = await db.collection('users').doc(userId).get();
        
        if (!userDoc.exists) {
            // Create default user document
            await db.collection('users').doc(userId).set({
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                role: 'hr_manager' // Default to hr_manager for testing
            });
            
            return res.json({
                role: 'hr_manager',
                permissions: {
                    view_candidates: true,
                    edit_candidates: true,
                    view_demob: true,
                    edit_demob: true,
                    view_analytics: true,
                    manage_users: false
                }
            });
        }
        
        const userData = userDoc.data();
        const role = userData.role || 'viewer';
        
        // Define permissions by role
        const rolePermissions = {
            admin: {
                view_candidates: true,
                edit_candidates: true,
                view_demob: true,
                edit_demob: true,
                view_analytics: true,
                manage_users: true
            },
            hr_manager: {
                view_candidates: true,
                edit_candidates: true,
                view_demob: true,
                edit_demob: true,
                view_analytics: true,
                manage_users: false
            },
            recruiter: {
                view_candidates: true,
                edit_candidates: true,
                view_demob: true,
                edit_demob: false,
                view_analytics: false,
                manage_users: false
            },
            viewer: {
                view_candidates: true,
                edit_candidates: false,
                view_demob: false,
                edit_demob: false,
                view_analytics: false,
                manage_users: false
            }
        };
        
        res.json({
            role,
            permissions: rolePermissions[role] || rolePermissions.viewer
        });
        
    } catch (error) {
        console.error('Error getting user permissions:', error);
        res.status(500).json({ error: error.message });
    }
});

// 8. Export demob data
exports.exportDemobData = functions.https.onRequest(async (req, res) => {
    // Handle CORS
    if (corsHandler(req, res)) return;
    
    try {
        const userId = await verifyUser(req);
        const { format = 'json', include_matches = true } = req.query;
        
        // Get all demob profiles
        const demobSnapshot = await db.collection('demob_profiles').get();
        const profiles = [];
        
        for (const doc of demobSnapshot.docs) {
            const profile = { id: doc.id, ...doc.data() };
            
            if (include_matches === 'true') {
                // Get matches for this profile
                const matchesSnapshot = await db.collection('demob_matches')
                    .where('employee_id', '==', doc.id)
                    .orderBy('match_score', 'desc')
                    .limit(5)
                    .get();
                    
                profile.top_matches = matchesSnapshot.docs.map(matchDoc => matchDoc.data());
            }
            
            profiles.push(profile);
        }
        
        if (format === 'csv') {
            // Convert to CSV format
            const csvHeaders = [
                'Employee ID',
                'Current Status',
                'Demob Date',
                'Current Project',
                'Current Role',
                'Performance Rating',
                'Years with Company',
                'Retention Priority',
                'Technical Skills',
                'Preferred Locations',
                'Willing to Relocate'
            ];
            
            const csvRows = profiles.map(p => [
                p.employee_id,
                p.current_status,
                p.demob_date,
                p.current_project?.name || '',
                p.current_project?.role || '',
                p.internal_metrics?.performance_rating || '',
                p.internal_metrics?.years_with_company || '',
                p.internal_metrics?.retention_priority || '',
                (p.skill_inventory?.technical_skills || []).join('; '),
                (p.mobility_preferences?.preferred_locations || []).join('; '),
                p.mobility_preferences?.willing_to_relocate ? 'Yes' : 'No'
            ]);
            
            const csv = [csvHeaders, ...csvRows]
                .map(row => row.map(cell => `"${cell}"`).join(','))
                .join('\n');
                
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=demob_profiles.csv');
            res.send(csv);
        } else {
            res.json({ profiles, total: profiles.length });
        }
        
    } catch (error) {
        console.error('Error exporting demob data:', error);
        res.status(500).json({ error: error.message });
    }
});

// Triggers for automatic matching
exports.onNewPosition = functions.firestore
    .document('users/{userId}/projects/{projectId}/positions/{positionId}')
    .onCreate(async (snap, context) => {
        const position = snap.data();
        const { userId, projectId, positionId } = context.params;
        
        console.log(`New position added: ${position.title} in project ${projectId}`);
        
        // Get project details
        const projectDoc = await db.collection(`users/${userId}/projects`).doc(projectId).get();
        const project = projectDoc.data();
        
        // Get all active demob profiles
        const demobSnapshot = await db.collection('demob_profiles')
            .where('current_status', '==', 'Active - Demobilizing')
            .get();
            
        const matches = [];
        
        for (const doc of demobSnapshot.docs) {
            const demobProfile = doc.data();
            const matchScore = calculateMatchScore(demobProfile, position);
            
            if (matchScore >= 75) {
                matches.push({
                    employee_id: demobProfile.employee_id,
                    project_id: projectId,
                    project_name: project?.projectName || 'Unknown',
                    position_id: positionId,
                    position_title: position.title,
                    match_score: matchScore
                });
            }
        }
        
        // Save high-scoring matches
        for (const match of matches) {
            await saveMatchRecord(match);
            
            if (match.match_score >= 85) {
                console.log(`High match found: Employee ${match.employee_id} for position ${positionId} (Score: ${match.match_score})`);
            }
        }
    });

exports.onDemobProfileUpdate = functions.firestore
    .document('demob_profiles/{employeeId}')
    .onUpdate(async (change, context) => {
        const employeeId = context.params.employeeId;
        const newData = change.after.data();
        const oldData = change.before.data();
        
        // Check if relevant fields changed
        const relevantFieldsChanged = 
            newData.demob_date !== oldData.demob_date ||
            JSON.stringify(newData.skill_inventory) !== JSON.stringify(oldData.skill_inventory) ||
            JSON.stringify(newData.mobility_preferences) !== JSON.stringify(oldData.mobility_preferences);
            
        if (relevantFieldsChanged) {
            console.log(`Demob profile updated: ${employeeId}, triggering re-matching`);
            await triggerMatching(employeeId);
        }
    });