const fs = require('fs');

const express = require('express');
const axios = require('axios');
const CryptoJS = require('crypto-js');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const Workshop = require('../models/Workshop');
const Discount = require('../models/Discount');
const auth = require('../express_middlewares/userAuth');

const { initPaymentUrl, verifyPaymentUrl } = require('../utils/consts');
const { checkPermission, sendWelcomeEmail, sendForgetPasswordEmail, redirectTo } = require('../utils/utils');
const { authenticateAdmin } = require('../express_middlewares/adminAuth');


const router = new express.Router();

async function createUser(req, res) {
    const validFields = ["firstName", "lastName", "email", "password", "phoneNumber", "studentNumber"];
    const finalBody = {};
    validFields.forEach(field => {
        finalBody[field] = req.body[field];
    });
    const user = new User(finalBody);

    try {
        await user.save();

        const token = await user.generateAuthToken();

        sendWelcomeEmail(user);
        res.status(201).send({ user, token });
    } catch (error) {
        res.status(400).send(error);
    }
}

router.post("/", async (req, res) => {
    await createUser(req, res);
});

router.post('/ac', authenticateAdmin, async (req, res) => {
    if (!checkPermission(req.admin, "addUser", res)) {
        return;
    }
    await createUser(req, res);
});

router.post('/login', async (req, res) => {
    try {
        const user = await User.findByCredentials(req.body.email, req.body.password);
        const token = await user.generateAuthToken();
        res.send({ user, token });
    } catch (error) {
        console.log(error);

        res.status(400).send({ error: error.message });
    }
});

router.post('/me/logout', auth, async (req, res) => {
    try {
        req.user.tokens = req.user.tokens.filter((token) => token.token !== req.token);
        await req.user.save();

        res.send();
    } catch (error) {
        res.status(500).send();
    }
});

router.post('/me/logoutAll', auth, async (req, res) => {
    try {
        req.user.tokens = [];

        await req.user.save();
        res.send();
    } catch (error) {
        res.status(500).send();
    }
});

router.get("/", authenticateAdmin, async (req, res) => {
    if (!checkPermission(req.admin, "getUser", res)) {
        return;
    }
    try {
        const users = await User.find();
        res.send(users);
    } catch (err) {
        res.status(500).send({ error: err.message });
    }
});

router.get('/me', auth, async (req, res) => {
    let workshops = [];
    for (const workshop of req.user.workshops) {
        workshops = workshops.concat(await Workshop.findById(workshop.workshop));
    }
    res.send({ user: req.user, workshops });
});

router.get("/:id", authenticateAdmin, async (req, res) => {
    if (!checkPermission(req.admin, "getUser", res)) {
        return;
    }
    try {
        const user = await User.findById(req.params.id);
        let workshops = [];
        for (const workshop of user.workshops) {
            workshops = workshops.concat(await Workshop.findById(workshop.workshop));
        }
        res.send({ user, workshops });
    } catch (err) {
        res.status(500).send({ error: err.message });
    }
});

router.post('/forget', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.body.email });

        if (!user) {
            res.status(404).send();
            return;
        }
        const forgotToken = await user.generateForgotToken(req.body.email);

        sendForgetPasswordEmail(user, forgotToken);

        res.status(200).send();

    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

async function userPatch(user, req, res, isAdmin) {
    const updates = Object.keys(req.body);
    let allowedUpdates = ['firstName', 'lastName', 'email', 'password', 'age', 'phoneNumber'];
    if (isAdmin) {
        allowedUpdates += 'studentNumber';
    }
    const isValidOperation = updates.every((update) => allowedUpdates.includes(update));

    if (!isValidOperation) {
        return res.status(400).send({ error: 'invalid updates' });
    }
    try {
        updates.forEach((update) => user[update] = req.body[update]);

        await user.save();

        res.send(user);
    } catch (error) {
        res.status(400).send(error);
    }
}

router.patch('/me', auth, async (req, res) => {
    await userPatch(req.user, req, res, false);
});

router.patch('/:id', authenticateAdmin, async (req, res) => {
    if (!checkPermission(req.admin, "editUser", res)) {
        res.status(401).send();
        return;
    }
    const user = await User.findById(req.params.id);
    if (!user) {
        res.status(404).send();
    }
    await userPatch(user, req, res, true);
});

router.patch('/forget/:token', async (req, res) => {
    try {
        const decodedEmail = jwt.verify(req.params.token, process.env.JWT_SECRET).email;
        const user = await User.findOne({ email: decodedEmail, 'forgotTokens.forgotToken': req.params.token });
        if (!user) {
            res.status(404).send();
            return;
        }
        user.password = req.body.password;
        user.forgotTokens.splice(user.forgotTokens.indexOf(user.forgotTokens.find(x => x.forgotToken === req.params.token)), 1);
        await user.save();


        res.status(200).send(user);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

async function userDelete(user, req, res) {
    try {
        await User.deleteOne(user);
        await user.save();
        res.send(user);
    } catch (error) {
        res.status(500).send();
    }
}

router.delete('/me', auth, async (req, res) => {
    await userDelete(req.user, req, res);
});

router.delete('/:id', authenticateAdmin, async (req, res) => {
    if (!checkPermission(req.admin, "deleteUser", res)) {
        res.status(401).send();
        return;
    }
    const user = await User.findById(req.params.id);
    if (!user) {
        res.status(404).send();
    }
    await userDelete(user, req, res);
});

// Payment

async function initPayment(user, workshops, workshopId, discountCode, res) {
    const rand = Math.floor(Math.random() * parseInt(process.env.RANDOM_MAX));
    const orderId = parseInt(user._id, 16) % rand;
    user.orderIDs = user.orderIDs.concat({ workshopId, idNumber: orderId });
    await user.save();

    let price = 0;
    workshops.forEach(workshop => {
        price += workshop.price;
    });
    try {
        if (discountCode) {
            const discount = await Discount.findByCode(discountCode);
            if (!discount) {
                throw new Error("Discount not found");
            }
            if (discount.count > 0 || discount.count === -1) {
                if (discount.count > 0) {
                    discount.count--;
                    await discount.save();
                }
                price *= ((discount.percentage) / 100);
                price = Math.floor(price);
            }
        }
    } catch (err) {
        console.log(err.message);
    }
    if (price === 0) {
        try {
            for (const workshop of workshops) {
                user.workshops = user.workshops.concat({ workshop: workshop._id })
            }
            await user.save();
            for (const workshop of workshops) {
                fs.appendFileSync("./ignore/register.log", `${user.email} : ${workshop.title}\n`);
                await workshop.save();
            }
        } catch (err) {
            console.log(err.message);
            res.status(400).send(`Error ${err.message}`);
            return { data: undefined };
        }
        res.send("OK");
        return { data: undefined };
    }
    const sign = process.env.TERMINAL_ID + ";" + orderId.toLocaleString('fullwide', { useGrouping: false }) + ";" + price.toLocaleString('fullwide', { useGrouping: false });

    const SignData = CryptoJS.TripleDES.encrypt(sign, CryptoJS.enc.Base64.parse(process.env.TERMINAL_KEY), {
        mode: CryptoJS.mode.ECB,
        padding: CryptoJS.pad.Pkcs7
    }).toString();
    console.log(SignData);

    const data = {
        MerchantId: process.env.MERCHANT_ID,
        TerminalId: process.env.TERMINAL_ID,
        Amount: price,
        OrderId: orderId,
        LocalDateTime: new Date(),
        ReturnUrl: `${process.env.BACK_SERVER}users/verifypayment`,
        SignData: SignData,
        PaymentIdentity: process.env.PAYMENT_IDENTITY
    }

    console.log(data);
    try {
        const response = await axios.post(initPaymentUrl, data);
        return response;
    } catch (err) {
        res.status(500).send(err.message);
        return;
    }
}

router.post('/initpayment', auth, async (req, res) => {
    let workshops = [];
    console.log("Init");
    try {
        for (const workshopId of req.body.workshopIds) {
            const workshop = await Workshop.findById(workshopId);
            if (!workshop) {
                res.status(404).send(`${workshopId} not found`);
                return;
            }
            try {
                //Check capacity
                let flag = true;
                await workshop.populate('participants').execPopulate();
                if (workshop.participants.length >= workshop.capacity) {
                    workshop.isRegOpen = false;
                    await workshop.save();
                }
                if (!workshop.isRegOpen) {
                    flag = false;
                }

                //Check already in or not
                for (const wsId of req.user.workshops) {
                    if (wsId.workshop == workshopId) {
                        flag = false;
                    }
                }
                if (flag) {
                    workshops = workshops.concat(workshop);
                }
            } catch (err) {
                res.status(500).send({ msg: err.message, err });
            }

        }
    } catch (err) {
        res.status(400).send(err.message);
    }
    if (workshops.length !== 0) {
        try {
            const sadadRes = (await initPayment(req.user, workshops, req.body.workshopIds, req.body.discount, res)).data;
            if (!sadadRes) {
                return;
            }
            console.log("BUG");
            console.log("DONE:   " + JSON.stringify(sadadRes) + "\n\n");
            if (sadadRes.ResCode === "0") {
                res.send(sadadRes.Token);
            } else {
                res.status(400).send(sadadRes.Description);
            }
        } catch (err) {
            res.status(500).send(err.message);
        }
    } else {
        res.status(400).send("No available workshop to register");
    }
});

async function verifySadad(data) {
    const sadadRes = (await axios.post(verifyPaymentUrl, data)).data;
    return sadadRes;
}

router.post('/verifypayment', async (req, res) => {
    const url = "payment/result"

    try {

        if (req.body.ResCode !== "0") {
            redirectTo(res, process.env.SITE + url, { status: "BAD", stage: `inital res code non 0  wtf is this:${req.body.ResCode}` });
            return;
        }
        const user = await User.findOne({
            "orderIDs.idNumber": req.body.OrderId
        });
        if (!user) {
            redirectTo(res, process.env.SITE + url, { status: "BAD", stage: "user not found wtf??" });
            return;
        }

        let order;
        for (const oi of user.orderIDs) {
            if (oi.idNumber == req.body.OrderId) {
                order = oi;
                break;
            }
        }

        const SignData = CryptoJS.TripleDES.encrypt(req.body.token, CryptoJS.enc.Base64.parse(process.env.TERMINAL_KEY), {
            mode: CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7
        }).toString();

        const data = {
            Token: req.body.token,
            SignData: SignData
        };

        console.log("verify payload: " + JSON.stringify(data));


        const now = (new Date()).getTime();
        const interval = setInterval(async () => {
            try {
                const sadadRes = await verifySadad(data);

                if (sadadRes) {
                    clearInterval(interval);

                    if (sadadRes.ResCode !== "0") {
                        redirectTo(res, process.env.SITE + url, { status: "BAD", stage: `verify res code non 0 its ${sadadRes.ResCode}` });
                        return;
                    }

                    user.orders = user.orders.concat({
                        ...sadadRes,
                        workshopIds: order.workshopId
                    });

                    for (const workshop of order.workshopId) {
                        user.workshops = user.workshops.concat({ workshop });
                    }

                    user.orderIDs.splice(user.orderIDs.indexOf(order), 1);
                    try {
                        await user.save();
                        for (const workshop of order.workshopId) {
                            const workshopObj = await Workshop.findById(workshop);
                            fs.writeFileSync("./ignore/register.log", `${user.email} : ${workshopObj.title}\n`);
                            await workshopObj.save();
                        }
                    } catch (err) {
                        console.error(JSON.stringify(err));
                        clearInterval(interval);
                        redirectTo(res, process.env.SITE + url, { status: "BAD", stage: "User save problem" });
                        return;
                    }

                    redirectTo(res, process.env.SITE + url, {
                        status: "GOOD",
                        Amount: sadadRes.Amount,
                        RetrivalRefNo: sadadRes.RetrivalRefNo,
                        SystemTraceNo: sadadRes.SystemTraceNo
                    });
                    return;
                } else if ((new Date()).getTime() - now > 10000) {
                    clearInterval(interval);
                    redirectTo(res, process.env.SITE + url, { status: "BAD", stage: "Time out" });
                    return;
                }
            } catch (err) {
                console.error(err.message);
                clearInterval(interval);
                redirectTo(res, process.env.SITE + url, { status: "BAD", stage: "Sadad req error" });
                return;
            }
        }, 2000);
    } catch (err) {
        console.error(err.message);
        console.error(err);
        res.status(500).send(err.message);
    }
});

module.exports = router;
