const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: ["http://localhost:5173", "http://localhost:3000"],
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Настройка multer для загрузки файлов
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB лимит
});

app.use(cors());
app.use(express.json());

// Раздача статических файлов
app.use('/models', express.static(path.join(__dirname, 'models')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    console.log('Новый клиент подключен:', socket.id);
    
    socket.on('authenticate', (userData) => {
        const { userId, userRole, clientId } = userData;
        
        socket.userId = userId;
        socket.userRole = userRole;
        
        socket.join(`user_${userId}`);
        console.log(`Пользователь ${userId} (${userRole}) добавлен в комнату user_${userId}`);
        
        if (userRole === 'client') {
            socket.join(`client_${userId}`);
            console.log(`Клиент ${userId} добавлен в комнату client_${userId}`);
        }
        
        if (userRole === 'manager' || userRole === 'admin') {
            socket.join('admins');
            console.log(`менеджер ${userId} добавлен в комнату admins`);
        }
        
        socket.emit('authenticated', { success: true, userId, userRole });
    });
    
    socket.on('disconnect', () => {
        console.log('Клиент отключен:', socket.id);
    });
});

// Функции для отправки уведомлений
function notifyUser(userId, eventName, data) {
    io.to(`user_${userId}`).emit(eventName, {
        ...data,
        timestamp: new Date().toISOString()
    });
}

function notifyAdmins(eventName, data) {
    io.to('admins').emit(eventName, {
        ...data,
        timestamp: new Date().toISOString()
    });
}

function emitNewRequest(requestData) {
    notifyAdmins('new_request', {
        request_id: requestData.id,
        request_number: requestData.request_number,
        client_name: requestData.client_name,
        service_name: requestData.service_name,
        total_cost: requestData.total_cost,
        created_at: requestData.created_at
    });
}

function emitRequestUpdate(requestId, status, data) {
    db.get(`SELECT client_id, request_number FROM requests WHERE id = ?`, [requestId], (err, request) => {
        if (err) {
            console.error('Ошибка получения данных заявки:', err);
            return;
        }
        
        if (request && request.client_id) {
            notifyUser(request.client_id, 'request_update', {
                request_id: requestId,
                request_number: request.request_number,
                status: status,
                data: data
            });
        }
        
        notifyAdmins('request_update', {
            request_id: requestId,
            request_number: request?.request_number,
            status: status,
            data: data
        });
    });
}

function emitPalletUpdate(palletId, status, data) {
    db.get(`
        SELECT p.*, r.client_id, r.request_number 
        FROM pallets p
        JOIN requests r ON p.request_id = r.id
        WHERE p.id = ?
    `, [palletId], (err, pallet) => {
        if (err) {
            console.error('Ошибка получения данных паллеты:', err);
            return;
        }
        
        if (pallet && pallet.client_id) {
            notifyUser(pallet.client_id, 'pallet_update', {
                pallet_id: palletId,
                pallet_code: pallet.pallet_code,
                request_id: pallet.request_id,
                request_number: pallet.request_number,
                status: status,
                data: data
            });
        }
        
        notifyAdmins('pallet_update', {
            pallet_id: palletId,
            pallet_code: pallet?.pallet_code,
            request_id: pallet?.request_id,
            request_number: pallet?.request_number,
            status: status,
            data: data
        });
    });
}

// ==================== 3D МОДЕЛИ ДЛЯ ТИПОВ ПАЛЛЕТ ====================

// Получить 3D модель для конкретного типа паллеты
app.get('/api/pallet-model/:type_code', (req, res) => {
    const { type_code } = req.params;
    console.log(`Запрос на получение 3D модели для типа: ${type_code}`);
    
    // Путь к файлу модели в папке models
    const modelPath = path.join(__dirname, 'models', `${type_code}.glb`);
    
    // Проверяем, существует ли файл модели
    if (fs.existsSync(modelPath)) {
        console.log(`Модель найдена: ${modelPath}`);
        const stat = fs.statSync(modelPath);
        const fileStream = fs.createReadStream(modelPath);
        
        res.setHeader('Content-Type', 'model/gltf-binary');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'public, max-age=3600'); // Кеширование на 1 час
        
        fileStream.pipe(res);
        
        fileStream.on('error', (error) => {
            console.error('Ошибка чтения файла модели:', error);
            res.status(500).json({ error: 'Ошибка чтения файла модели' });
        });
    } else {
        // Если файл не найден, пробуем найти общую модель
        const defaultModelPath = path.join(__dirname, 'models', 'pallet.glb');
        
        if (fs.existsSync(defaultModelPath)) {
            console.log(`Модель для ${type_code} не найдена, используем общую модель: ${defaultModelPath}`);
            const stat = fs.statSync(defaultModelPath);
            const fileStream = fs.createReadStream(defaultModelPath);
            
            res.setHeader('Content-Type', 'model/gltf-binary');
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            
            fileStream.pipe(res);
            
            fileStream.on('error', (error) => {
                console.error('Ошибка чтения файла модели:', error);
                res.status(500).json({ error: 'Ошибка чтения файла модели' });
            });
        } else {
            console.log(`Модель для ${type_code} не найдена: ${modelPath}`);
            res.status(404).json({ 
                error: 'Модель не найдена',
                type_code: type_code,
                message: `Файл модели ${type_code}.glb не найден в папке models`
            });
        }
    }
});

// Получить информацию о наличии модели для типа паллеты
app.get('/api/pallet-model-info/:type_code', (req, res) => {
    const { type_code } = req.params;
    
    const modelPath = path.join(__dirname, 'models', `${type_code}.glb`);
    const defaultModelPath = path.join(__dirname, 'models', 'pallet.glb');
    
    const modelExists = fs.existsSync(modelPath);
    const defaultExists = fs.existsSync(defaultModelPath);
    
    res.json({
        type_code: type_code,
        has_specific_model: modelExists,
        has_default_model: defaultExists,
        specific_model_path: modelExists ? modelPath : null,
        default_model_path: defaultExists ? defaultModelPath : null,
        will_serve: modelExists || defaultExists
    });
});

// Получить список всех доступных моделей
app.get('/api/pallet-models/list', (req, res) => {
    const modelsDir = path.join(__dirname, 'models');
    
    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
        return res.json({ models: [], message: 'Папка models создана, добавьте файлы .glb' });
    }
    
    const files = fs.readdirSync(modelsDir);
    const glbFiles = files.filter(file => file.endsWith('.glb'));
    
    const models = glbFiles.map(file => ({
        filename: file,
        type_code: file.replace('.glb', ''),
        path: `/models/${file}`,
        size: fs.statSync(path.join(modelsDir, file)).size
    }));
    
    res.json({
        models: models,
        count: models.length,
        directory: modelsDir
    });
});

// Проверка всех типов паллет на наличие моделей
app.get('/api/pallet-models/check-all', (req, res) => {
    // Получаем все типы паллет из БД
    db.all(`SELECT type_code, name FROM pallet_types WHERE is_active = 1 ORDER BY sort_order`, [], (err, types) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        const results = [];
        
        types.forEach(type => {
            const modelPath = path.join(__dirname, 'models', `${type.type_code}.glb`);
            const defaultModelPath = path.join(__dirname, 'models', 'pallet.glb');
            
            const hasModel = fs.existsSync(modelPath);
            const hasDefault = fs.existsSync(defaultModelPath);
            
            results.push({
                type_code: type.type_code,
                name: type.name,
                has_model: hasModel,
                has_fallback: hasDefault,
                model_path: hasModel ? modelPath : (hasDefault ? defaultModelPath : null),
                status: hasModel ? 'ready' : (hasDefault ? 'using_fallback' : 'missing')
            });
        });
        
        res.json(results);
    });
});

// Загрузка модели для типа паллеты (админский endpoint)
app.post('/api/admin/pallet-model/:type_code', upload.single('model'), (req, res) => {
    const { type_code } = req.params;
    
    if (!req.file) {
        return res.status(400).json({ error: 'Файл модели не загружен' });
    }
    
    const modelDir = path.join(__dirname, 'models');
    const modelPath = path.join(modelDir, `${type_code}.glb`);
    
    // Создаем папку если её нет
    if (!fs.existsSync(modelDir)) {
        fs.mkdirSync(modelDir, { recursive: true });
    }
    
    // Сохраняем файл
    fs.writeFile(modelPath, req.file.buffer, (err) => {
        if (err) {
            console.error('Ошибка сохранения модели:', err);
            return res.status(500).json({ error: 'Ошибка сохранения файла' });
        }
        
        console.log(`Модель для ${type_code} сохранена: ${modelPath}`);
        
        res.json({ 
            success: true, 
            message: `Модель для ${type_code} загружена`,
            type_code: type_code,
            path: modelPath,
            size: req.file.size
        });
    });
});

// Удаление модели для типа паллеты
app.delete('/api/admin/pallet-model/:type_code', (req, res) => {
    const { type_code } = req.params;
    const modelPath = path.join(__dirname, 'models', `${type_code}.glb`);
    
    if (fs.existsSync(modelPath)) {
        fs.unlinkSync(modelPath);
        console.log(`Модель для ${type_code} удалена: ${modelPath}`);
        
        res.json({ 
            success: true, 
            message: `Модель для ${type_code} удалена`,
            type_code: type_code
        });
    } else {
        res.status(404).json({ 
            error: 'Модель не найдена',
            type_code: type_code
        });
    }
});

// Проверка файла модели
app.get('/api/check-model-file', (req, res) => {
    const modelPath = path.join(__dirname, 'models', 'pallet.glb');
    
    if (fs.existsSync(modelPath)) {
        const stats = fs.statSync(modelPath);
        res.json({ 
            exists: true, 
            size: stats.size,
            path: modelPath,
            url: '/models/pallet.glb'
        });
    } else {
        const modelsDir = path.join(__dirname, 'models');
        if (!fs.existsSync(modelsDir)) {
            fs.mkdirSync(modelsDir, { recursive: true });
        }
        res.json({ 
            exists: false, 
            error: 'Файл pallet.glb не найден',
            message: 'Положите файл модели в папку ' + modelsDir
        });
    }
});

// Настройка nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'mishamagobul@gmail.com',
        pass: 'zyhu kdmc ymax rgjv'
    }
});

function getManagerEmailFromDB() {
    return new Promise((resolve, reject) => {
        db.get('SELECT email FROM users WHERE role = ? AND is_active = 1 LIMIT 1',
            ['manager'], (err, row) => {
                if (err) {
                    console.error('Ошибка получения email менеджера:', err.message);
                    reject(err);
                    return;
                }
                if (row && row.email) {
                    console.log(`Найден менеджер в БД: ${row.email}`);
                    resolve(row.email);
                } else {
                    console.log('Менеджер не найден в базе данных');
                    resolve(null);
                }
            });
    });
}

async function sendNewRequestEmail(requestData) {
    try {
        const managerEmail = await getManagerEmailFromDB();
        
        const mailOptions = {
            from: 'mishamagobul@gmail.com',
            to: managerEmail || 'magobul@gmail.com',
            subject: `Новая заявка №${requestData.request_number} - ${requestData.service_name}`,
            text: `Новая заявка №${requestData.request_number}
            Клиент: ${requestData.client_name}
            Телефон: ${requestData.phone}
            Email: ${requestData.email}
            Услуга: ${requestData.service_name}
            Описание: ${requestData.description}
            Сумма: ${requestData.total_cost} руб.
            Дата создания: ${new Date(requestData.created_at).toLocaleString('ru-RU')}`
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('Email отправлен менеджеру:', info.messageId);
        return { success: true };
    } catch (error) {
        console.error('Ошибка отправки email:', error);
        return { success: false, error: error.message };
    }
}

// Подключение к БД
const db = new sqlite3.Database('./base.db', (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err.message);
    } else {
        console.log('Подключено к БД успешно');
        
        // Создаем папку для моделей если её нет
        const modelsDir = path.join(__dirname, 'models');
        if (!fs.existsSync(modelsDir)) {
            fs.mkdirSync(modelsDir, { recursive: true });
            console.log('Создана папка для моделей:', modelsDir);
        }
    }
});

// ==================== КАЛЬКУЛЯТОР ПАЛЛЕТ ====================

app.post('/api/pallets/recommend', (req, res) => {
    const { length, width, height } = req.body;
    
    if (!length || !width || !height) {
        return res.status(400).json({ error: 'Не указаны размеры' });
    }
    
    db.all(`SELECT * FROM pallet_types WHERE is_active = 1 AND type_code != 'other' ORDER BY sort_order`, 
        (err, palletTypes) => {
            if (err) return res.status(500).json({ error: err.message });
            
            let bestMatch = null;
            let minDifference = Infinity;
            
            for (const pallet of palletTypes) {
                const dimensions = pallet.dimensions.split('×').map(Number);
                if (dimensions.length === 3) {
                    const [pLength, pWidth, pHeight] = dimensions;
                    
                    const lengthDiff = Math.abs(pLength - length);
                    const widthDiff = Math.abs(pWidth - width);
                    const heightDiff = Math.abs(pHeight - height);
                    const totalDiff = lengthDiff + widthDiff + heightDiff;
                    
                    if (totalDiff < minDifference) {
                        minDifference = totalDiff;
                        bestMatch = pallet;
                    }
                }
            }
            
            if (bestMatch && minDifference < 150) {
                res.json({
                    found: true,
                    pallet: {
                        id: bestMatch.id,
                        type_code: bestMatch.type_code,
                        name: bestMatch.name,
                        dimensions: bestMatch.dimensions,
                        price: bestMatch.price,
                        model: bestMatch.model,
                        model_url: bestMatch.model ? `/models/${bestMatch.model}` : null,
                        difference: minDifference
                    }
                });
            } else {
                res.json({
                    found: false,
                    message: 'Не найдено подходящего паллета'
                });
            }
        });
});

app.post('/api/requests/calculate', (req, res) => {
    const { 
        service_id, 
        pallet_type_code, 
        pallet_quantity,
        delivery_method 
    } = req.body;
    
    if (!service_id || !pallet_type_code || !pallet_quantity) {
        return res.status(400).json({ error: 'Не указаны обязательные поля' });
    }
    
    db.get('SELECT base_price FROM services WHERE id = ? AND is_active = 1', 
        [service_id], (err, service) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!service) return res.status(404).json({ error: 'Услуга не найдена' });
            
            db.get('SELECT price FROM pallet_types WHERE type_code = ? AND is_active = 1', 
                [pallet_type_code], (err, palletType) => {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    const palletPrice = palletType ? palletType.price : 0;
                    const servicePricePerUnit = service.base_price;
                    const deliveryCost = delivery_method === 'delivery' ? 3500 : 0;
                    const serviceCost = (servicePricePerUnit + palletPrice) * pallet_quantity;
                    const totalCost = serviceCost + deliveryCost;
                    
                    res.json({
                        service_price_per_unit: servicePricePerUnit,
                        pallet_price: palletPrice,
                        total_per_unit: servicePricePerUnit + palletPrice,
                        service_cost: serviceCost,
                        delivery_cost: deliveryCost,
                        total_cost: totalCost,
                        pallet_quantity: pallet_quantity
                    });
                });
        });
});

// ==================== ПОЛЬЗОВАТЕЛИ ====================
app.get('/api/users/:id', (req, res) => {
    const { id } = req.params;
    
    db.get(`SELECT id, email, name, phone, role, created_at, last_login 
            FROM users 
            WHERE id = ? AND is_active = 1`, 
        [id], 
        (err, user) => {
            if (err) {
                console.error('Ошибка получения пользователя:', err);
                return res.status(500).json({ error: err.message });
            }
            if (!user) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }
            res.json(user);
        });
});

app.post('/api/register', (req, res) => {
    const { email, password, name, phone } = req.body;
    
    db.get('SELECT id FROM users WHERE email = ?', [email], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) return res.status(400).json({ error: 'Email уже существует' });
        
        db.run('INSERT INTO users (email, password_hash, role, name, phone) VALUES (?, ?, ?, ?, ?)',
            [email, password, 'client', name, phone],
            function(err) {
                if (err) {
                    console.error('Ошибка регистрации:', err.message);
                    return res.status(500).json({ error: err.message });
                }
                
                db.get('SELECT id, email, name, phone, role, created_at, last_login FROM users WHERE id = ?',
                    [this.lastID], (err, user) => {
                        if (err) return res.status(500).json({ error: err.message });
                        res.json({
                            message: 'Регистрация успешна',
                            user: {
                                id: user.id,
                                email: user.email,
                                name: user.name,
                                phone: user.phone,
                                role: user.role,
                                created_at: user.created_at
                            }
                        });
                    });
            });
    });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    db.get('SELECT * FROM users WHERE email = ? AND is_active = 1',
        [email], (err, user) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!user || user.password_hash !== password) {
                return res.status(401).json({ error: 'Неверные данные' });
            }
            
            db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
            
            res.json({
                message: 'Вход успешен',
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    phone: user.phone,
                    role: user.role
                }
            });
        });
});

// ==================== ТИПЫ ПАЛЛЕТ ====================

app.get('/api/pallet-types', (req, res) => {
    db.all(`SELECT * FROM pallet_types WHERE is_active = 1 ORDER BY sort_order`,
        (err, types) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const typesWithModel = types.map(type => ({
                ...type,
                model_url: type.model ? `/models/${type.model}` : null,
                max_load_weight: type.max_load_weight || 1500
            }));
            
            res.json(typesWithModel);
        });
});

app.get('/api/pallet-types/:code', (req, res) => {
    const { code } = req.params;
    
    db.get(`SELECT * FROM pallet_types WHERE type_code = ? AND is_active = 1`,
        [code], (err, type) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!type) return res.status(404).json({ error: 'Тип паллеты не найден' });
            
            res.json({
                ...type,
                model_url: type.model ? `/models/${type.model}` : null
            });
        });
});

// ==================== УСЛУГИ ====================

app.get('/api/services', (req, res) => {
    db.all('SELECT * FROM services WHERE is_active = 1 ORDER BY sort_order', (err, services) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(services);
    });
});

// ==================== ГАЛЕРЕЯ ====================


// Путь к папке с изображениями галереи
const galleryPath = path.join(__dirname, 'models', 'gallery');

// Создаем папку для галереи если её нет
if (!fs.existsSync(galleryPath)) {
    fs.mkdirSync(galleryPath, { recursive: true });
    console.log('📁 Создана папка для галереи:', galleryPath);
}

// Раздача статических файлов галереи
app.use('/gallery', express.static(galleryPath));

// ==================== ОСНОВНЫЕ ЭНДПОИНТЫ ====================

// 1. Получить все изображения галереи
app.get('/api/gallery', (req, res) => {
    db.all('SELECT * FROM gallery WHERE is_published = 1 ORDER BY sort_order, created_at DESC', (err, gallery) => {
        if (err) {
            console.error('Ошибка получения галереи:', err);
            return res.status(500).json({ error: err.message });
        }
        console.log(`📸 Загружено ${gallery.length} изображений из галереи`);
        res.json(gallery);
    });
});

// 2. Получить изображение по ID
app.get('/api/gallery/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM gallery WHERE id = ? AND is_published = 1', [id], (err, image) => {
        if (err) {
            console.error('Ошибка получения изображения:', err);
            return res.status(500).json({ error: err.message });
        }
        if (!image) {
            return res.status(404).json({ error: 'Изображение не найдено' });
        }
        res.json(image);
    });
});

// 3. Получить список файлов в папке галереи
app.get('/api/gallery/files/list', (req, res) => {
    try {
        if (!fs.existsSync(galleryPath)) {
            return res.json({ 
                success: false, 
                message: 'Папка галереи не найдена',
                path: galleryPath 
            });
        }
        
        const files = fs.readdirSync(galleryPath);
        const imageFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);
        });
        
        // Получаем данные из БД для сравнения
        db.all('SELECT file_path FROM gallery', [], (err, dbFiles) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            const dbFilePaths = dbFiles.map(f => f.file_path);
            
            res.json({
                success: true,
                path: galleryPath,
                files: imageFiles,
                count: imageFiles.length,
                in_db: imageFiles.filter(f => dbFilePaths.includes(f)),
                not_in_db: imageFiles.filter(f => !dbFilePaths.includes(f)),
                fullUrls: imageFiles.map(f => `/gallery/${f}`)
            });
        });
        
    } catch (error) {
        console.error('Ошибка получения списка файлов:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. Проверить наличие конкретного файла
app.get('/api/gallery/check/:filename', (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(galleryPath, filename);
    const exists = fs.existsSync(filePath);
    
    res.json({
        filename: filename,
        exists: exists,
        path: filePath,
        url: `/gallery/${filename}`
    });
});

// ==================== АДМИНСКИЕ ЭНДПОИНТЫ ====================

// 5. Синхронизация файлов с БД (автоматическое обновление)
app.post('/api/admin/gallery/sync-files', (req, res) => {
    console.log('🔄 Синхронизация файлов с БД...');
    
    try {
        if (!fs.existsSync(galleryPath)) {
            return res.status(404).json({ error: 'Папка галереи не найдена' });
        }
        
        const files = fs.readdirSync(galleryPath);
        const imageFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);
        });
        
        console.log(` Найдено файлов в папке: ${imageFiles.length}`);
        console.log(' Файлы:', imageFiles);
        
        // Получаем все записи из БД
        db.all('SELECT id, file_path, title FROM gallery', [], (err, dbFiles) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            console.log(` Записей в БД: ${dbFiles.length}`);
            
            let updated = 0;
            let added = 0;
            let notFound = 0;
            
            // Проверяем каждую запись в БД
            dbFiles.forEach(dbFile => {
                // Проверяем, существует ли файл с таким именем
                const fileExists = fs.existsSync(path.join(galleryPath, dbFile.file_path));
                
                if (!fileExists) {
                    // Ищем похожий файл (без расширения)
                    const baseName = path.parse(dbFile.file_path).name;
                    const foundFile = imageFiles.find(f => {
                        const fBase = path.parse(f).name;
                        return fBase === baseName || 
                               fBase.toLowerCase() === baseName.toLowerCase() ||
                               fBase.includes(baseName) || 
                               baseName.includes(fBase);
                    });
                    
                    if (foundFile) {
                        // Обновляем имя файла в БД
                        db.run(
                            'UPDATE gallery SET file_path = ? WHERE id = ?',
                            [foundFile, dbFile.id],
                            function(err) {
                                if (err) {
                                    console.error('Ошибка обновления:', err);
                                } else {
                                    updated++;
                                    console.log(` Обновлен: ${dbFile.file_path} → ${foundFile} (ID: ${dbFile.id})`);
                                }
                            }
                        );
                    } else {
                        notFound++;
                        console.log(` Файл не найден: ${dbFile.file_path}`);
                    }
                }
            });
            
            
            // Ждем завершения всех операций
            setTimeout(() => {
                // Получаем обновленную статистику
                db.get('SELECT COUNT(*) as count FROM gallery', [], (err, result) => {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    
                    res.json({
                        success: true,
                        message: 'Синхронизация завершена',
                        updated: updated,
                        added: added,
                        not_found: notFound,
                        files_in_folder: imageFiles.length,
                        total_in_db: result.count
                    });
                });
            }, 2000);
        });
        
    } catch (error) {
        console.error(' Ошибка синхронизации:', error);
        res.status(500).json({ error: error.message });
    }
});

// 6. Загрузить новое изображение
app.post('/api/admin/gallery', upload.single('image'), (req, res) => {
    const { title, description, category, uploaded_by } = req.body;
    
    if (!req.file) {
        return res.status(400).json({ error: 'Файл изображения не загружен' });
    }
    
    if (!title) {
        return res.status(400).json({ error: 'Название изображения обязательно' });
    }
    
    try {
        const ext = path.extname(req.file.originalname);
        const filename = `${Date.now()}${ext}`;
        const filePath = path.join(galleryPath, filename);
        
        fs.writeFileSync(filePath, req.file.buffer);
        console.log(` Файл сохранен: ${filePath}`);
        
        db.run(
            `INSERT INTO gallery (title, description, file_path, category, uploaded_by, created_at) 
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [title, description || '', filename, category || 'Общее', uploaded_by || 'Администратор'],
            function(err) {
                if (err) {
                    fs.unlinkSync(filePath);
                    return res.status(500).json({ error: err.message });
                }
                
                res.json({
                    success: true,
                    message: 'Изображение загружено',
                    id: this.lastID,
                    file_path: filename,
                    url: `/gallery/${filename}`,
                    title: title,
                    description: description || '',
                    category: category || 'Общее',
                    uploaded_by: uploaded_by || 'Администратор'
                });
            }
        );
    } catch (error) {
        console.error('Ошибка загрузки изображения:', error);
        res.status(500).json({ error: 'Ошибка сохранения файла' });
    }
});

// 7. Обновить информацию об изображении
app.put('/api/admin/gallery/:id', (req, res) => {
    const { id } = req.params;
    const { title, description, category, sort_order, is_published, uploaded_by } = req.body;
    
    let query = 'UPDATE gallery SET ';
    const params = [];
    const updates = [];
    
    if (title !== undefined) {
        updates.push('title = ?');
        params.push(title);
    }
    if (description !== undefined) {
        updates.push('description = ?');
        params.push(description);
    }
    if (category !== undefined) {
        updates.push('category = ?');
        params.push(category);
    }
    if (sort_order !== undefined) {
        updates.push('sort_order = ?');
        params.push(sort_order);
    }
    if (is_published !== undefined) {
        updates.push('is_published = ?');
        params.push(is_published);
    }
    if (uploaded_by !== undefined) {
        updates.push('uploaded_by = ?');
        params.push(uploaded_by);
    }
    
    if (updates.length === 0) {
        return res.status(400).json({ error: 'Нет данных для обновления' });
    }
    
    query += updates.join(', ') + ' WHERE id = ?';
    params.push(id);
    
    db.run(query, params, function(err) {
        if (err) {
            console.error('Ошибка обновления:', err);
            return res.status(500).json({ error: err.message });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Изображение не найдено' });
        }
        
        // Получаем обновленные данные
        db.get('SELECT * FROM gallery WHERE id = ?', [id], (err, updatedImage) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({
                success: true,
                message: 'Изображение обновлено',
                image: updatedImage
            });
        });
    });
});

// 8. Удалить изображение
app.delete('/api/admin/gallery/:id', (req, res) => {
    const { id } = req.params;
    
    // Получаем путь к файлу
    db.get('SELECT file_path FROM gallery WHERE id = ?', [id], (err, image) => {
        if (err) {
            console.error('Ошибка получения изображения:', err);
            return res.status(500).json({ error: err.message });
        }
        if (!image) {
            return res.status(404).json({ error: 'Изображение не найдено' });
        }
        
        // Удаляем запись из БД
        db.run('DELETE FROM gallery WHERE id = ?', [id], function(err) {
            if (err) {
                console.error('Ошибка удаления из БД:', err);
                return res.status(500).json({ error: err.message });
            }
            
            // Удаляем файл
            try {
                const fullPath = path.join(galleryPath, image.file_path);
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                    console.log(` Файл удален: ${fullPath}`);
                } else {
                    console.log(` Файл не найден: ${fullPath}`);
                }
                res.json({ 
                    success: true, 
                    message: 'Изображение удалено',
                    file_path: image.file_path
                });
            } catch (error) {
                console.error('Ошибка удаления файла:', error);
                res.json({ 
                    success: true, 
                    message: 'Изображение удалено из БД, но файл не был удален',
                    error: error.message
                });
            }
        });
    });
});

// 9. Массовое обновление file_path в БД (если переименовали файлы)
app.post('/api/admin/gallery/update-paths', (req, res) => {
    const { mappings } = req.body;
    
    if (!mappings || !Array.isArray(mappings)) {
        return res.status(400).json({ error: 'Требуется массив mappings с полями id и new_path' });
    }
    
    let updated = 0;
    let errors = 0;
    
    mappings.forEach(({ id, new_path }) => {
        if (!id || !new_path) {
            errors++;
            return;
        }
        
        db.run(
            'UPDATE gallery SET file_path = ? WHERE id = ?',
            [new_path, id],
            function(err) {
                if (err) {
                    console.error('Ошибка обновления:', err);
                    errors++;
                } else {
                    updated++;
                    console.log(` Обновлен ID ${id}: file_path = ${new_path}`);
                }
            }
        );
    });
    
    setTimeout(() => {
        res.json({
            success: true,
            message: 'Обновление завершено',
            updated: updated,
            errors: errors
        });
    }, 1000);
});

console.log(' Модуль галереи загружен');

// ==================== ЗАЯВКИ ====================

app.post('/api/requests', (req, res) => {
    const {
        client_id,
        service_id,
        description,
        pallet_quantity,
        pallet_type_code,
        pallet_dimensions,
        total_cost
    } = req.body;
    
    console.log('Получены данные заявки:', req.body);
    
    if (!client_id || !service_id) {
        return res.status(400).json({ error: 'Не указаны обязательные поля' });
    }
    
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    
    db.get('SELECT COUNT(*) as cnt FROM requests WHERE date(created_at) = date("now")', (err, row) => {
        if (err) {
            console.error('Ошибка подсчета заявок:', err);
            return res.status(500).json({ error: err.message });
        }
        
        const seq = String((row?.cnt || 0) + 1).padStart(4, '0');
        const requestNumber = `ЗАЯВКА-${dateStr}-${seq}`;
        
        db.run(`INSERT INTO requests 
                (request_number, client_id, service_id, status, description, total_cost) 
                VALUES (?, ?, ?, 'new', ?, ?)`,
            [requestNumber, client_id, service_id, description, total_cost || null],
            function(err) {
                if (err) {
                    console.error('Ошибка создания заявки:', err.message);
                    return res.status(500).json({ error: err.message });
                }
                
                const requestId = this.lastID;
                console.log(`Заявка создана. ID: ${requestId}, Номер: ${requestNumber}`);
                
                db.get(`
                    SELECT u.name as client_name, u.email, u.phone, s.name as service_name
                    FROM users u
                    CROSS JOIN services s
                    WHERE u.id = ? AND s.id = ?
                `, [client_id, service_id], (err, emailData) => {
                    if (err) {
                        console.error('Ошибка получения данных для email:', err);
                    } else if (emailData) {
                        sendNewRequestEmail({
                            request_number: requestNumber,
                            client_name: emailData.client_name,
                            phone: emailData.phone,
                            email: emailData.email,
                            service_name: emailData.service_name,
                            description: description || 'не указано',
                            total_cost: total_cost || 0,
                            created_at: new Date().toISOString()
                        });
                    }
                });
                
                if (pallet_quantity && pallet_quantity > 0) {
                    db.get('SELECT id FROM pallet_types WHERE type_code = ?', [pallet_type_code || 'euro1'], (err, palletType) => {
                        if (err) {
                            console.error('Ошибка получения типа паллеты:', err);
                            return;
                        }
                        
                        const palletTypeId = palletType ? palletType.id : null;
                        const defaultDimensions = pallet_dimensions || '1200×800×145';
                        const material = 'дерево';
                        
                        const stmt = db.prepare(`
                            INSERT INTO pallets 
                            (pallet_code, request_id, pallet_type_id, dimensions, material, status) 
                            VALUES (?, ?, ?, ?, ?, 'in_stock')
                        `);
                        
                        for (let i = 1; i <= pallet_quantity; i++) {
                            const palletCode = `ПАЛ-${dateStr}-${String(requestId).padStart(4, '0')}-${String(i).padStart(3, '0')}`;
                            stmt.run(palletCode, requestId, palletTypeId, defaultDimensions, material, (err) => {
                                if (err) console.error('Ошибка создания паллеты:', err);
                            });
                        }
                        
                        stmt.finalize();
                        console.log(`Создано ${pallet_quantity} паллет для заявки #${requestId}`);
                    });
                }
                
                res.json({
                    success: true,
                    message: 'Заявка успешно создана',
                    request_id: requestId,
                    request_number: requestNumber
                });
            });
    });
});

app.get('/api/client/requests/:client_id', (req, res) => {
    const { client_id } = req.params;
    
    db.all(`SELECT r.*, s.name as service_name 
            FROM requests r 
            LEFT JOIN services s ON r.service_id = s.id 
            WHERE r.client_id = ? 
            ORDER BY r.created_at DESC`,
        [client_id], (err, requests) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(requests);
        });
});

// ==================== ПАЛЛЕТЫ ====================

app.get('/api/requests/:request_id/pallets', (req, res) => {
    const { request_id } = req.params;
    
    db.all(`SELECT p.*, pt.type_code, pt.name as pallet_type_name, 
                   pt.price as pallet_price, pt.model, pt.dimensions as type_dimensions
            FROM pallets p
            LEFT JOIN pallet_types pt ON p.pallet_type_id = pt.id
            WHERE p.request_id = ? 
            ORDER BY p.id`,
        [request_id],
        (err, pallets) => {
            if (err) {
                console.error('Ошибка получения паллет:', err);
                return res.status(500).json({ error: err.message });
            }
            
            const palletsWithModel = pallets.map(pallet => ({
                ...pallet,
                model_url: pallet.model ? `/models/${pallet.model}` : null
            }));
            
            res.json(palletsWithModel || []);
        });
});

app.put('/api/pallets/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    
    const validStatuses = ['in_stock', 'in_repair', 'transferred', 'in_transit', 'written_off'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Неверный статус' });
    }
    
    db.run(`UPDATE pallets 
            SET status = ?, 
                status_updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?`,
        [status, id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            console.log(`Паллета #${id} изменена статус на ${status}`);
            
            emitPalletUpdate(id, status, { updated_at: new Date().toISOString() });
            
            res.json({
                message: 'Статус паллеты обновлен',
                status: status,
                updated_at: new Date().toISOString()
            });
        });
});

app.put('/api/requests/:request_id/pallets/status', (req, res) => {
    const { request_id } = req.params;
    const { status } = req.body;
    
    db.run(`UPDATE pallets 
            SET status = ?, 
                status_updated_at = CURRENT_TIMESTAMP 
            WHERE request_id = ?`,
        [status, request_id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            emitRequestUpdate(request_id, status, { updated_count: this.changes });
            
            res.json({
                message: `Статус обновлен для ${this.changes} паллет`,
                updated_count: this.changes
            });
        });
});

app.get('/api/pallets/total-stats', (req, res) => {
    db.get(`SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'in_stock' THEN 1 ELSE 0 END) as in_stock,
                SUM(CASE WHEN status = 'in_repair' THEN 1 ELSE 0 END) as in_repair,
                SUM(CASE WHEN status = 'transferred' THEN 1 ELSE 0 END) as transferred,
                SUM(CASE WHEN status = 'in_transit' THEN 1 ELSE 0 END) as in_transit,
                SUM(CASE WHEN status = 'written_off' THEN 1 ELSE 0 END) as written_off
            FROM pallets`,
        (err, stats) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(stats);
        });
});

app.get('/api/pallets/search', (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        return res.status(400).json({ error: 'Не указан код паллеты' });
    }
    
    db.get(`SELECT p.*, pt.type_code, pt.name as pallet_type_name, 
                   pt.price as pallet_price, pt.model, pt.dimensions as type_dimensions,
                   r.request_number, u.name as client_name 
            FROM pallets p
            LEFT JOIN pallet_types pt ON p.pallet_type_id = pt.id
            JOIN requests r ON p.request_id = r.id
            JOIN users u ON r.client_id = u.id
            WHERE p.pallet_code = ?`,
        [code],
        (err, pallet) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!pallet) return res.status(404).json({ error: 'Паллета не найдена' });
            
            pallet.model_url = pallet.model ? `/models/${pallet.model}` : null;
            
            res.json(pallet);
        });
});

// ==================== АДМИН ====================

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get('SELECT * FROM users WHERE email = ? AND role IN (?, ?) AND is_active = 1',
        [username, 'manager', 'admin'], (err, admin) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!admin || admin.password_hash !== password) {
                return res.status(401).json({ error: 'Неверные данные' });
            }
            
            db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [admin.id]);
            
            res.json({
                message: 'Вход успешен',
                user: {
                    id: admin.id,
                    email: admin.email,
                    name: admin.name,
                    role: admin.role
                }
            });
        });
});

app.get('/api/admin/requests', (req, res) => {
    db.all(`SELECT r.*, s.name as service_name, u.name as client_name, u.email, u.phone
             FROM requests r 
             LEFT JOIN services s ON r.service_id = s.id 
             LEFT JOIN users u ON r.client_id = u.id
             ORDER BY r.created_at DESC`, (err, requests) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(requests);
    });
});

app.put('/api/admin/requests/:id', (req, res) => {
    const { id } = req.params;
    const { status, manager_comment } = req.body;
    
    let query = 'UPDATE requests SET ';
    const params = [];
    const updates = [];
    
    if (status !== undefined) {
        updates.push('status = ?');
        params.push(status);
        
        if (status === 'in_work') {
            updates.push('actual_start_date = date("now")');
        } else if (status === 'completed') {
            updates.push('actual_end_date = date("now")');
        }
    }
    if (manager_comment !== undefined) {
        updates.push('manager_comment = ?');
        params.push(manager_comment);
    }
    
    updates.push('updated_at = CURRENT_TIMESTAMP');
    query += updates.join(', ') + ' WHERE id = ?';
    params.push(id);
    
    db.run(query, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        emitRequestUpdate(id, status, { manager_comment });
        
        res.json({ message: 'Заявка обновлена' });
    });
});

app.get('/api/admin/stats', (req, res) => {
    db.get(`SELECT 
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_requests,
                SUM(CASE WHEN status = 'in_work' THEN 1 ELSE 0 END) as in_work_requests,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_requests,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_requests
            FROM requests`, (err, stats) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(stats);
    });
});

// ==================== СОТРУДНИКИ ====================

app.get('/api/admin/employees', (req, res) => {
    db.all(`SELECT e.*, u.name, u.email, u.phone 
            FROM employees e 
            JOIN users u ON e.id = u.id 
            WHERE u.is_active = 1`, (err, employees) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(employees);
    });
});

app.post('/api/admin/employees', (req, res) => {
    const { email, password, name, phone, position, experience_years, specialization } = req.body;
    
    db.run('BEGIN TRANSACTION');
    
    db.run(`INSERT INTO users (email, password_hash, role, name, phone, is_active) 
            VALUES (?, ?, 'employee', ?, ?, 1)`,
        [email, password, name, phone],
        function(err) {
            if (err) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: err.message });
            }
            
            const userId = this.lastID;
            
            db.run(`INSERT INTO employees (id, position, experience_years, specialization) 
                    VALUES (?, ?, ?, ?)`,
                [userId, position, experience_years || 0, specialization || ''],
                function(err) {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: err.message });
                    }
                    
                    db.run('COMMIT');
                    res.json({ success: true, id: userId });
                });
        });
});

app.put('/api/admin/employees/:id', (req, res) => {
    const { id } = req.params;
    const { position, experience_years, specialization, is_active } = req.body;
    
    db.run(`UPDATE employees SET position = ?, experience_years = ?, specialization = ? WHERE id = ?`,
        [position, experience_years, specialization, id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            
            if (is_active !== undefined) {
                db.run(`UPDATE users SET is_active = ? WHERE id = ?`, [is_active, id]);
            }
            
            res.json({ message: 'Сотрудник обновлен' });
        });
});

// ==================== КАЛЕНДАРЬ ЗАНЯТОСТИ ====================

// Получить загрузку сотрудника на конкретную дату
app.get('/api/employees/:id/load', (req, res) => {
    const { id } = req.params;
    const { date } = req.query;
    
    if (!date) {
        return res.status(400).json({ error: 'Не указана дата' });
    }
    
    db.all(`SELECT start_time, end_time, duration_hours, request_id
            FROM calendar_events 
            WHERE employee_id = ? AND event_date = ? AND status != 'cancelled'`,
        [id, date], (err, events) => {
            if (err) {
                console.error('Ошибка получения загрузки:', err);
                return res.status(500).json({ error: err.message });
            }
            
            let totalHours = 0;
            events.forEach(event => {
                totalHours += event.duration_hours || 0;
            });
            
            res.json({
                employee_id: id,
                date: date,
                total_hours: totalHours,
                remaining_hours: Math.max(0, 8 - totalHours),
                events: events,
                is_available: totalHours < 8
            });
        });
});

// Получить доступных сотрудников на период
app.post('/api/employees/available', (req, res) => {
    const { start_datetime, end_datetime, exclude_employee_id } = req.body;
    
    console.log(' Запрос на поиск сотрудников:', { start_datetime, end_datetime, exclude_employee_id });
    
    if (!start_datetime || !end_datetime) {
        return res.status(400).json({ error: 'Не указаны даты начала и окончания' });
    }
    
    const startDate = new Date(start_datetime);
    const endDate = new Date(end_datetime);
    const durationHours = (endDate - startDate) / (1000 * 60 * 60);
    
    console.log(`⏱ Длительность: ${durationHours} часов`);
    
    // Получаем всех активных сотрудников
    db.all(`SELECT e.*, u.name 
            FROM employees e 
            JOIN users u ON e.id = u.id 
            WHERE u.is_active = 1 
            ORDER BY e.experience_years DESC`,
        [], async (err, employees) => {
            if (err) {
                console.error(' Ошибка получения сотрудников:', err);
                return res.status(500).json({ error: err.message });
            }
            
            console.log(`👥 Найдено сотрудников: ${employees.length}`);
            
            if (employees.length === 0) {
                return res.json([]);
            }
            
            const availableEmployees = [];
            
            for (const employee of employees) {
                if (exclude_employee_id && employee.id == exclude_employee_id) continue;
                
                // Проверяем доступность сотрудника
                const isAvailable = await checkEmployeeAvailability(
                    employee.id,
                    startDate,
                    endDate,
                    durationHours
                );
                
                console.log(` Сотрудник ${employee.id} (${employee.name}):`, isAvailable);
                
                if (isAvailable.available) {
                    availableEmployees.push({
                        ...employee,
                        load_by_day: isAvailable.dailyLoad || {},
                        recommended: employee.experience_years >= 3
                    });
                }
            }
            
            console.log(` Доступных сотрудников: ${availableEmployees.length}`);
            
            // Логируем детально каждого доступного сотрудника
            availableEmployees.forEach(emp => {
                console.log(`   ${emp.name}: загрузка по дням:`, emp.load_by_day);
            });
            
            availableEmployees.sort((a, b) => {
                if (a.recommended && !b.recommended) return -1;
                if (!a.recommended && b.recommended) return 1;
                return b.experience_years - a.experience_years;
            });
            
            res.json(availableEmployees);
        });
});

function checkEmployeeAvailability(employeeId, startDate, endDate, requiredHours) {
    return new Promise((resolve, reject) => {
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];
        
        console.log(` Проверка сотрудника ${employeeId} на период ${startDateStr} - ${endDateStr}`);
        
        // Получаем все события сотрудника за период
        db.all(`SELECT event_date, start_time, end_time, duration_hours 
                FROM calendar_events 
                WHERE employee_id = ? 
                AND event_date BETWEEN ? AND ?
                AND status != 'cancelled'`,
            [employeeId, startDateStr, endDateStr], (err, events) => {
                if (err) {
                    console.error(' Ошибка получения событий:', err);
                    return reject(err);
                }
                
                console.log(` Найдено событий для сотрудника ${employeeId}:`, events.length);
                if (events.length > 0) {
                    console.log(' События:', JSON.stringify(events, null, 2));
                }
                
                // Создаем объект загрузки по дням
                const dailyLoad = {};
                
                events.forEach(event => {
                    if (!dailyLoad[event.event_date]) {
                        dailyLoad[event.event_date] = 0;
                    }
                    dailyLoad[event.event_date] += event.duration_hours || 0;
                });
                
                console.log(` Загрузка по дням для сотрудника ${employeeId}:`, dailyLoad);
                
                // Проверяем доступность
                let available = true;
                const currentDate = new Date(startDate);
                const workingDays = getWorkingDays(startDate, endDate);
                const requiredDailyHours = workingDays > 0 ? requiredHours / workingDays : 0;
                
                console.log(` Рабочих дней: ${workingDays}, требуется часов в день: ${requiredDailyHours.toFixed(2)}`);
                
                // Проверяем каждый день периода
                while (currentDate <= endDate) {
                    const dateStr = currentDate.toISOString().split('T')[0];
                    const currentLoad = dailyLoad[dateStr] || 0;
                    const dayOfWeek = currentDate.getDay();
                    
                    console.log(`  ${dateStr}: день ${dayOfWeek}, загрузка ${currentLoad}, требуется +${requiredDailyHours}`);
                    
                    // Проверяем только рабочие дни
                    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                        // Проверяем, что в этот день нет перегрузки
                        if (currentLoad + requiredDailyHours > 8) {
                            console.log(` Сотрудник ${employeeId} НЕ доступен: ${dateStr} - загрузка ${currentLoad} + требуется ${requiredDailyHours} > 8`);
                            available = false;
                            break;
                        }
                    }
                    currentDate.setDate(currentDate.getDate() + 1);
                }
                
                console.log(` Сотрудник ${employeeId} доступен: ${available}`);
                console.log(` Итоговая загрузка:`, dailyLoad);
                
                resolve({
                    available: available,
                    dailyLoad: dailyLoad
                });
            });
    });
}

// Назначить сотрудника на заявку
app.post('/api/requests/:id/assign', (req, res) => {
    const { id } = req.params;
    const { employee_id, start_datetime, end_datetime } = req.body;
    
    console.log(` Назначение сотрудника ${employee_id} на заявку ${id}`);
    console.log(` Период: ${start_datetime} - ${end_datetime}`);
    
    if (!employee_id || !start_datetime || !end_datetime) {
        return res.status(400).json({ error: 'Не указаны обязательные поля' });
    }
    
    const startDate = new Date(start_datetime);
    const endDate = new Date(end_datetime);
    const durationHours = (endDate - startDate) / (1000 * 60 * 60);
    
    console.log(`⏱ Длительность: ${durationHours} часов`);
    
    // Проверяем, что длительность больше 0
    if (durationHours <= 0) {
        return res.status(400).json({ 
            error: 'Продолжительность работ должна быть больше 0 часов' 
        });
    }
    
    // Проверка на выходные дни
    let hasWeekend = false;
    const weekendDays = [];
    const currentDateCheck = new Date(startDate);
    
    while (currentDateCheck <= endDate) {
        const day = currentDateCheck.getDay();
        if (day === 0 || day === 6) {
            hasWeekend = true;
            weekendDays.push(currentDateCheck.toLocaleDateString('ru-RU', { 
                weekday: 'long', 
                day: 'numeric', 
                month: 'short' 
            }));
        }
        currentDateCheck.setDate(currentDateCheck.getDate() + 1);
    }
    
    if (hasWeekend) {
        return res.status(400).json({
            error: 'В выбранный период входят выходные дни',
            weekend_days: weekendDays,
            message: `Период содержит выходные: ${weekendDays.join(', ')}. Пожалуйста, выберите рабочие дни.`
        });
    }
    
    checkEmployeeAvailability(employee_id, startDate, endDate, durationHours)
        .then((availability) => {
            console.log(` Результат проверки доступности:`, availability);
            
            if (!availability.available) {
                return res.status(409).json({
                    error: 'Сотрудник занят в выбранный период',
                    daily_load: availability.dailyLoad
                });
            }
            
            // Обновляем заявку
            db.run(`UPDATE requests 
                    SET assigned_employee_id = ?, 
                        planned_start_date = ?,
                        planned_end_date = ?,
                        status = 'in_work',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?`,
                [employee_id, start_datetime.split('T')[0], end_datetime.split('T')[0], id],
                function(err) {
                    if (err) {
                        console.error(' Ошибка обновления заявки:', err);
                        return res.status(500).json({ error: err.message });
                    }
                    
                    console.log(` Заявка ${id} обновлена, сотрудник назначен`);
                    
                    // Создаем события в календаре
                    const stmt = db.prepare(`
                        INSERT INTO calendar_events 
                        (employee_id, request_id, event_date, start_time, end_time, duration_hours, status) 
                        VALUES (?, ?, ?, ?, ?, ?, 'scheduled')
                    `);
                    
                    let currentDate = new Date(startDate);
                    let dayCount = 0;
                    let eventsCreated = 0;
                    const WORK_START = 9;
                    const MAX_HOURS_PER_DAY = 8;
                    let remainingHours = durationHours;
                    
                    console.log(` Начало создания событий с ${startDate} по ${endDate}`);
                    console.log(` Всего часов: ${durationHours}`);
                    
                    while (currentDate <= endDate && remainingHours > 0.01) {
                        const dateStr = currentDate.toISOString().split('T')[0];
                        const dayOfWeek = currentDate.getDay();
                        
                        console.log(` Обработка дня ${dateStr}, день недели ${dayOfWeek}, осталось часов: ${remainingHours.toFixed(2)}`);
                        
                        // Проверяем рабочий день (пн-пт)
                        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                            // Определяем сколько часов можно взять сегодня
                            let dailyHours;
                            
                            if (remainingHours >= MAX_HOURS_PER_DAY) {
                                dailyHours = MAX_HOURS_PER_DAY;
                            } else {
                                dailyHours = Math.round(remainingHours * 100) / 100;
                            }
                            
                            // Для первого дня используем время из запроса
                            let startTime;
                            let endTime;
                            
                            if (dayCount === 0) {
                                // Первый день - используем время начала
                                const startHour = String(startDate.getHours()).padStart(2, '0');
                                const startMinute = String(startDate.getMinutes()).padStart(2, '0');
                                startTime = `${startHour}:${startMinute}:00`;
                                
                                // Рассчитываем время окончания для первого дня
                                const totalMinutes = startDate.getHours() * 60 + startDate.getMinutes() + dailyHours * 60;
                                const endHour = Math.floor(totalMinutes / 60);
                                const endMinute = Math.round(totalMinutes % 60);
                                endTime = `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}:00`;
                            } else {
                                // Следующие дни - с 9:00
                                startTime = '09:00:00';
                                const endHour = WORK_START + Math.floor(dailyHours);
                                const endMinute = String(Math.round((dailyHours % 1) * 60)).padStart(2, '0');
                                endTime = `${String(endHour).padStart(2, '0')}:${endMinute}:00`;
                            }
                            
                            console.log(` Создание события: сотрудник ${employee_id}, дата ${dateStr}, ${dailyHours} часов, ${startTime}-${endTime}`);
                            
                            stmt.run([employee_id, id, dateStr, startTime, endTime, dailyHours]);
                            eventsCreated++;
                            remainingHours -= dailyHours;
                            dayCount++;
                            
                            console.log(` Создано событие ${eventsCreated}, осталось часов: ${remainingHours.toFixed(2)}`);
                        } else {
                            console.log(`⏭️ Пропуск выходного дня: ${dateStr}`);
                        }
                        
                        // Переходим к следующему дню
                        currentDate.setDate(currentDate.getDate() + 1);
                        currentDate.setHours(WORK_START, 0, 0, 0);
                    }
                    
                    stmt.finalize();
                    
                    console.log(` Всего создано событий: ${eventsCreated}`);
                    
                    // Проверяем, что события добавились
                    db.all(`SELECT * FROM calendar_events WHERE request_id = ?`, [id], (err, events) => {
                        if (err) {
                            console.error(' Ошибка проверки событий:', err);
                        } else {
                            console.log(` Создано ${events.length} событий для заявки ${id}`);
                            events.forEach(event => {
                                console.log(`   ${event.event_date}: ${event.start_time} - ${event.end_time} (${event.duration_hours} ч)`);
                            });
                        }
                    });
                    
                    emitRequestUpdate(id, 'assigned', { employee_id, start_datetime, end_datetime });
                    
                    res.json({
                        message: 'Сотрудник назначен на заявку',
                        request_id: id,
                        employee_id: employee_id,
                        start_date: start_datetime,
                        end_date: end_datetime,
                        events_created: eventsCreated
                    });
                });
        })
        .catch(err => {
            console.error(' Ошибка проверки доступности:', err);
            res.status(500).json({ error: err.message });
        });
});

// Получить календарь сотрудника
app.get('/api/employees/:id/calendar', (req, res) => {
    const { id } = req.params;
    const { start_date, end_date } = req.query;
    
    console.log(` Запрос календаря для сотрудника ${id} с ${start_date} по ${end_date}`);
    
    let query = `SELECT ce.*, r.request_number, r.description 
                 FROM calendar_events ce
                 JOIN requests r ON ce.request_id = r.id
                 WHERE ce.employee_id = ?`;
    const params = [id];
    
    if (start_date) {
        query += ' AND ce.event_date >= ?';
        params.push(start_date);
    }
    if (end_date) {
        query += ' AND ce.event_date <= ?';
        params.push(end_date);
    }
    
    query += ' AND ce.status != "cancelled"';
    query += ' ORDER BY ce.event_date, ce.start_time';
    
    db.all(query, params, (err, events) => {
        if (err) {
            console.error('Ошибка получения календаря:', err);
            return res.status(500).json({ error: err.message });
        }
        
        console.log(` Найдено событий: ${events.length}`);
        
        const calendar = {};
        events.forEach(event => {
            if (!calendar[event.event_date]) {
                calendar[event.event_date] = {
                    total_hours: 0,
                    events: []
                };
            }
            calendar[event.event_date].total_hours += event.duration_hours || 0;
            calendar[event.event_date].events.push(event);
        });
        
        console.log(' Календарь:', calendar);
        
        res.json(calendar);
    });
});

app.get('/api/employees/availability/week', (req, res) => {
    const { start_date } = req.query;
    
    if (!start_date) {
        return res.status(400).json({ error: 'Не указана начальная дата' });
    }
    
    const startDate = new Date(start_date);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);
    
    db.all(`SELECT e.*, u.name 
            FROM employees e 
            JOIN users u ON e.id = u.id 
            WHERE u.is_active = 1`, [], (err, employees) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];
        
        db.all(`SELECT employee_id, event_date, duration_hours 
                FROM calendar_events 
                WHERE event_date BETWEEN ? AND ?
                AND status != 'cancelled'`,
            [startDateStr, endDateStr], (err, events) => {
                if (err) return res.status(500).json({ error: err.message });
                
                const result = employees.map(emp => {
                    const weekLoad = {};
                    for (let i = 0; i < 7; i++) {
                        const date = new Date(startDate);
                        date.setDate(date.getDate() + i);
                        const dateStr = date.toISOString().split('T')[0];
                        weekLoad[dateStr] = 0;
                    }
                    
                    events.forEach(event => {
                        if (event.employee_id === emp.id && weekLoad[event.event_date] !== undefined) {
                            weekLoad[event.event_date] += event.duration_hours || 0;
                        }
                    });
                    
                    return {
                        ...emp,
                        week_load: weekLoad,
                        total_week_hours: Object.values(weekLoad).reduce((a, b) => a + b, 0)
                    };
                });
                
                res.json(result);
            });
    });
});

// Вспомогательная функция
function getWorkingDays(startDate, endDate) {
    let count = 0;
    const currentDate = new Date(startDate);
    // Устанавливаем время в 00:00:00 для корректного сравнения
    currentDate.setHours(0, 0, 0, 0);
    const endDateTime = new Date(endDate);
    endDateTime.setHours(0, 0, 0, 0);
    
    while (currentDate <= endDateTime) {
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            count++;
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }
    return count || 1;
}

// ==================== КАЛЬКУЛЯТОР НАГРУЗКИ НА ПАЛЛЕТУ ====================

app.post('/api/pallets/calculate-load', async (req, res) => {
    const { weight, pallet_type_code, load_type, conditions } = req.body;
    
    if (!weight || !pallet_type_code || !load_type || !conditions) {
        return res.status(400).json({ 
            error: 'Не указаны обязательные поля: weight, pallet_type_code, load_type, conditions' 
        });
    }
    
    if (weight <= 0) {
        return res.status(400).json({ error: 'Вес груза должен быть больше 0' });
    }
    
    try {
        const result = await calculatePalletLoad({
            weight: weight,
            palletTypeCode: pallet_type_code,
            loadType: load_type,
            conditions: conditions
        });
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Ошибка расчета нагрузки:', error);
        res.status(500).json({ error: 'Ошибка при расчете нагрузки на паллету' });
    }
});

async function calculatePalletLoad(params) {
    const { weight, palletTypeCode, loadType, conditions } = params;
    
    const getBaseLoad = () => {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT max_load_weight, name FROM pallet_types WHERE type_code = ? AND is_active = 1`,
                [palletTypeCode],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else if (row) {
                        resolve(row);
                    } else {
                        resolve({ max_load_weight: 1500, name: palletTypeCode });
                    }
                }
            );
        });
    };
    
    try {
        const palletData = await getBaseLoad();
        const P_base = palletData.max_load_weight;
        const palletName = palletData.name;
        
        const distributionFactor = {
            uniform: 1.0,
            point: 0.7
        };
        const K_distribution = distributionFactor[loadType] || 1.0;
        
        const conditionsFactor = {
            dry: 1.0,
            wet: 0.8,
            aggressive: 0.6
        };
        const K_conditions = conditionsFactor[conditions] || 1.0;
        
        const P_allowed = P_base * K_distribution * K_conditions;
        
        let conclusion = '';
        let status = '';
        let recommendation = '';
        let safetyMargin = ((P_allowed - weight) / P_allowed * 100).toFixed(1);
        
        if (weight <= P_allowed) {
            status = 'success';
            conclusion = `Паллета "${palletName}" выдерживает заданную нагрузку`;
            
            if (safetyMargin > 30) {
                recommendation = 'Паллета имеет значительный запас прочности, можно использовать для более тяжелых грузов';
            } else if (safetyMargin > 10) {
                recommendation = 'Паллета надежна, рекомендуется соблюдать условия эксплуатации';
            } else {
                recommendation = 'Паллета выдерживает нагрузку, но запас прочности минимален';
            }
        } else {
            status = 'danger';
            conclusion = `Паллета "${palletName}" НЕ выдерживает заданную нагрузку`;
            const overloadPercent = ((weight - P_allowed) / P_allowed * 100).toFixed(1);
            
            if (overloadPercent > 50) {
                recommendation = 'Критическая перегрузка! Требуется усиление конструкции или использование нескольких паллет';
            } else if (overloadPercent > 20) {
                recommendation = 'Существенная перегрузка. Рекомендуется ремонт, усиление или замена паллеты';
            } else {
                recommendation = 'Небольшая перегрузка. Возможно временное использование, но рекомендуется усиление';
            }
        }
        
        return {
            success: status === 'success',
            status: status,
            conclusion: conclusion,
            recommendation: recommendation,
            pallet_name: palletName,
            calculations: {
                base_load: P_base,
                distribution_factor: K_distribution,
                conditions_factor: K_conditions,
                allowed_load: Math.round(P_allowed),
                actual_load: weight,
                safety_margin: parseFloat(safetyMargin),
                load_percent: Math.round((weight / P_allowed) * 100)
            }
        };
        
    } catch (error) {
        console.error('Ошибка при расчете нагрузки:', error);
        throw new Error('Не удалось выполнить расчет нагрузки на паллету');
    }
}

// ==================== ЭКСПОРТ ДАННЫХ В EXCEL ====================

const XLSX = require('xlsx');

app.get('/api/admin/export/excel', (req, res) => {
    const { status, start_date, end_date } = req.query;
    
    let query = `
        SELECT 
            r.request_number AS 'Номер заявки',
            u.name AS 'Клиент',
            u.phone AS 'Телефон',
            u.email AS 'Email',
            s.name AS 'Услуга',
            r.status AS 'Статус',
            r.total_cost AS 'Стоимость, руб',
            r.description AS 'Описание',
            r.created_at AS 'Дата создания',
            r.planned_start_date AS 'Плановая дата начала',
            r.planned_end_date AS 'Плановая дата окончания',
            r.actual_start_date AS 'Фактическая дата начала',
            r.actual_end_date AS 'Фактическая дата окончания',
            e.name AS 'Назначенный сотрудник'
        FROM requests r
        LEFT JOIN users u ON r.client_id = u.id
        LEFT JOIN services s ON r.service_id = s.id
        LEFT JOIN employees emp ON r.assigned_employee_id = emp.id
        LEFT JOIN users e ON emp.id = e.id
        WHERE 1=1
    `;
    
    const params = [];
    
    query += ' ORDER BY r.created_at DESC';
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('Ошибка экспорта данных:', err);
            return res.status(500).json({ error: err.message });
        }
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Нет данных для экспорта' });
        }
        
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(rows);
        
        const colWidths = [
            { wch: 20 }, { wch: 20 }, { wch: 15 }, { wch: 25 }, { wch: 25 },
            { wch: 15 }, { wch: 15 }, { wch: 30 }, { wch: 20 }, { wch: 20 },
            { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 25 }
        ];
        ws['!cols'] = colWidths;
        
        XLSX.utils.book_append_sheet(wb, ws, 'Заявки');
        
        const dateStr = new Date().toISOString().split('T')[0];
        const fileName = `requests_${dateStr}.xlsx`;
        
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    });
});

app.get('/api/admin/export/pallets-excel', (req, res) => {
    const { status, request_id } = req.query;
    
    let query = `
        SELECT 
            p.pallet_code AS 'Код паллеты',
            pt.name AS 'Тип паллеты',
            p.dimensions AS 'Размеры',
            p.material AS 'Материал',
            p.status AS 'Статус',
            r.request_number AS 'Номер заявки',
            u.name AS 'Клиент',
            p.created_at AS 'Дата создания',
            p.status_updated_at AS 'Дата изменения статуса'
        FROM pallets p
        LEFT JOIN pallet_types pt ON p.pallet_type_id = pt.id
        LEFT JOIN requests r ON p.request_id = r.id
        LEFT JOIN users u ON r.client_id = u.id
        WHERE 1=1
    `;
    
    const params = [];
    
    query += ' ORDER BY p.created_at DESC';
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('Ошибка экспорта паллет:', err);
            return res.status(500).json({ error: err.message });
        }
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Нет данных для экспорта' });
        }
        
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(rows);
        
        const colWidths = [
            { wch: 20 }, { wch: 25 }, { wch: 15 }, { wch: 15 },
            { wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }
        ];
        ws['!cols'] = colWidths;
        
        XLSX.utils.book_append_sheet(wb, ws, 'Паллеты');
        
        const dateStr = new Date().toISOString().split('T')[0];
        const fileName = `pallets_${dateStr}.xlsx`;
        
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    });
});

// ==================== ЗАПУСК СЕРВЕРА ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(` Сервер запущен на порту ${PORT}`);
    console.log(` http://localhost:${PORT}`);
});